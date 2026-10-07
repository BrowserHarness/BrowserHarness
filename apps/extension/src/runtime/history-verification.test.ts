// Memory v2, Phase 8 review fixes: a browser task's saved answer is linked to
// its task episode, and every recall path (the Context Compiler and /recall)
// carries what the task's verifier concluded. Durable task and history
// records keep no secrets.
import { beforeEach, describe, expect, it } from "vitest";
import { loadTaskHistory, saveTaskHistoryEntry } from "./history";
import { CONTRADICTED_ANSWER, verificationOfEpisode, withVerification } from "./history-verification";
import { recallCommand } from "./recall";
import type { BrowserSessionActionEvidence, BrowserTaskSessionEvidence } from "./session-evidence";
import { runTaskDag, type TaskDagNodeSpec } from "./task-dag";
import { episodesForSessions, saveTaskEpisodeMemory, taskEpisodeFromSession, TASK_EPISODE_MEMORY_KEY } from "./task-memory";
import { dagEvidenceFromResult, redactSecrets } from "./task-provenance";
import { compileContext, renderContext } from "./context";

let local: Record<string, unknown>;
function area(store: () => Record<string, unknown>) {
  return {
    get: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((name) => name in store()).map((name) => [name, structuredClone(store()[name])]));
    },
    set: async (value: Record<string, unknown>) => void Object.assign(store(), structuredClone(value)),
    remove: async (key: string | string[]) => {
      for (const name of Array.isArray(key) ? key : [key]) delete store()[name];
    }
  };
}

beforeEach(() => {
  local = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: area(() => local), session: area(() => ({})) } }
  });
});

const SPACE = "space-a";
const ANSWER = "Vendor A has a free plan for everyone.";

const spec = (id: string, task: string, type: "research" | "verify" = "research", dependencies: string[] = []): TaskDagNodeSpec => ({ id, task, type, dependencies, step_budget: 8 });

function action(id: string, extra: Partial<BrowserSessionActionEvidence> = {}): BrowserSessionActionEvidence {
  const page = { tab_id: 1, url: "https://vendor-a.example/", title: "Vendor A" };
  return { id, ordinal: 1, recorded_at: "2026-10-07T00:00:00.000Z", tool: "agent", input: {}, note: "", before: page, approval: { required: false, approved: true }, ...extra };
}

/** A browser task whose DAG researched a claim and had it checked with this verifier answer, saved with its answer. */
async function verifiedTask(sessionId: string, verifierAnswer: string | null, answer = ANSWER, spaceId = SPACE): Promise<void> {
  const specs = [spec("research-1", "Find whether Vendor A has a free plan")];
  if (verifierAnswer !== null) specs.push(spec("verify-1", "Check the free plan claim", "verify", ["research-1"]));
  const result = await runTaskDag(specs, async ({ node }) => ({
    status: "completed",
    message: node.type === "verify" ? verifierAnswer ?? "" : "Vendor A has a free plan.",
    steps: 1,
    session_id: `${sessionId}:worker:${node.id}`,
    sources: [{ url: node.type === "verify" ? "https://regulator.example/a" : "https://vendor-a.example/pricing", title: "Page" }],
    tools_used: ["read_page"]
  }));
  const dag = dagEvidenceFromResult(result)!;
  const evidence: BrowserTaskSessionEvidence = {
    version: 1,
    session_id: sessionId,
    title: "Vendor A plans",
    task: "Check whether Vendor A has a free plan",
    started_at: "2026-10-07T00:00:00.000Z",
    status: "completed",
    start: { tab_id: 1, url: "https://vendor-a.example/", title: "Vendor A" },
    actions: [action("action-1", { delegation: { kind: "dag", worker_count: dag.nodes.length, completed_count: dag.completed_count, non_completed_count: 0, workers: [], dag } })],
    tab_evidence: []
  };
  await saveTaskEpisodeMemory(evidence, spaceId);
  await saveTaskHistoryEntry({ task: "Check whether Vendor A has a free plan", result: answer, url: "https://vendor-a.example/", session_id: sessionId }, spaceId);
}

const recallRequest = "What did I find last time about the Vendor A free plan?";
const compiled = async (request = recallRequest) => renderContext(await compileContext({ request, spaceId: SPACE, intent: "chat" }));

/** Every line that mentions the claim also says it was contradicted. */
function neverUnqualified(text: string) {
  expect(text).not.toContain(ANSWER);
  for (const line of text.split("\n").filter((line) => line.includes("has a free plan."))) expect(line).toMatch(/CONTRADICTED/);
}

describe("history linked to its task episode", () => {
  it("saves the browser task's session id on the history entry and finds the episode through it", async () => {
    await verifiedTask("task-1", "VERDICT: contradicted");
    const [entry] = await loadTaskHistory(SPACE);
    expect(entry.session_id).toBe("task-1");
    const episodes = await episodesForSessions(["task-1"], SPACE);
    expect(episodes.get("task-1")?.dag_runs?.[0].nodes).toHaveLength(2);
    // The episode stays the one evidence record: history copies none of it.
    expect(Object.keys(entry).sort()).toEqual(["id", "result", "session_id", "task", "timestamp", "url"]);
  });

  it("never reads another Space's episode for a history link", async () => {
    await verifiedTask("task-1", "VERDICT: contradicted", ANSWER, "space-b");
    expect((await episodesForSessions(["task-1"], SPACE)).size).toBe(0);
    const [entry] = await withVerification([{ id: "h", task: "t", result: ANSWER, timestamp: "2026-10-07T00:00:00.000Z", session_id: "task-1" }], SPACE);
    expect(entry.verification).toBeUndefined();
  });
});

describe("contradicted answers", () => {
  it("are not supplied to the compiled context; the verdict is", async () => {
    await verifiedTask("task-1", "VERDICT: contradicted. The regulator lists no free plan.");
    const text = await compiled();
    expect(text).toContain(CONTRADICTED_ANSWER);
    expect(text).toContain("Checked “Vendor A has a free plan.”: CONTRADICTED when checked: treat it as wrong, not as a fact");
    neverUnqualified(text);
  });

  it("are not repeated by /recall", async () => {
    await verifiedTask("task-1", "VERDICT: contradicted");
    const text = await recallCommand("Vendor A free plan", SPACE);
    expect(text).toContain("From your past conversations");
    expect(text).toContain(CONTRADICTED_ANSWER);
    neverUnqualified(text);
  });

  it("win over a supported check in the same task", async () => {
    const specs = [spec("a", "Claim A"), spec("b", "Claim B"), spec("va", "Check A", "verify", ["a"]), spec("vb", "Check B", "verify", ["b"])];
    const result = await runTaskDag(specs, async ({ node }) => ({ status: "completed", message: node.id === "va" ? "VERDICT: supported" : node.id === "vb" ? "VERDICT: contradicted" : "claim", steps: 1, session_id: `s:${node.id}`, sources: [], tools_used: [] }));
    const evidence = { version: 1, session_id: "s", title: "t", task: "t", started_at: "x", status: "completed", start: { tab_id: 1, url: "https://a.example/", title: "A" }, actions: [action("action-1", { delegation: { kind: "dag", worker_count: 4, completed_count: 4, non_completed_count: 0, workers: [], dag: dagEvidenceFromResult(result)! } })], tab_evidence: [] } as BrowserTaskSessionEvidence;
    expect(verificationOfEpisode(taskEpisodeFromSession(evidence, undefined, SPACE))?.state).toBe("contradicted");
  });
});

describe("supported and inconclusive answers", () => {
  it("supported answers come back as true at that time, in the compiler and /recall", async () => {
    await verifiedTask("task-1", "VERDICT: supported");
    for (const text of [await compiled(), await recallCommand("Vendor A free plan", SPACE)]) {
      expect(text).toContain(`${ANSWER} [supported by the sources checked at that time; may have changed]`);
    }
  });

  it("inconclusive answers come back marked unverified", async () => {
    await verifiedTask("task-1", "I could not tell either way.");
    for (const text of [await compiled(), await recallCommand("Vendor A free plan", SPACE)]) {
      expect(text).toContain(`${ANSWER} [UNVERIFIED: the check was inconclusive, so don't treat this as established]`);
      expect(text).toContain("could not be confirmed when checked (inconclusive)");
    }
  });

  it("a failed or blocked check counts as unverified, never supported", async () => {
    const result = await runTaskDag([spec("r", "Claim"), spec("v", "Check", "verify", ["r"])], async ({ node }) =>
      node.id === "r" ? Promise.reject(new Error("down")) : { status: "completed", message: "VERDICT: supported", steps: 1, session_id: "s:v", sources: [], tools_used: [] }
    );
    const evidence = { version: 1, session_id: "s", title: "t", task: "t", started_at: "x", status: "completed", start: { tab_id: 1, url: "https://a.example/", title: "A" }, actions: [action("action-1", { delegation: { kind: "dag", worker_count: 2, completed_count: 0, non_completed_count: 2, workers: [], dag: dagEvidenceFromResult(result)! } })], tab_evidence: [] } as BrowserTaskSessionEvidence;
    expect(verificationOfEpisode(taskEpisodeFromSession(evidence, undefined, SPACE))?.state).toBe("insufficient");
  });
});

describe("answers with no verifier", () => {
  it("a linked task whose helpers had no verifier recalls as before", async () => {
    await verifiedTask("task-1", null);
    const text = await recallCommand("Vendor A free plan", SPACE);
    expect(text).toContain(ANSWER);
    expect(text).not.toMatch(/UNVERIFIED|supported by|CONTRADICTED/);
  });

  it("an older entry with no link, and a chat-only answer, recall as before", async () => {
    local["browserharness.taskHistory"] = [{ id: "old", task: "Compare kettle prices", result: "The Philips kettle is cheapest.", timestamp: "2026-10-05T00:00:00.000Z" }];
    await saveTaskHistoryEntry({ task: "What is a good kettle brand?", result: "Philips and Bosch are reliable kettle brands." });
    const recalled = await recallCommand("kettle", undefined);
    expect(recalled).toContain("The Philips kettle is cheapest.");
    expect(recalled).toContain("Philips and Bosch are reliable kettle brands.");
    const text = renderContext(await compileContext({ request: "Which kettle did I find last time?", spaceId: "personal", intent: "chat" }));
    expect(text).toContain("The Philips kettle is cheapest.");
  });
});

describe("secrets in durable task and history records", () => {
  it("are never kept in a TaskEpisodeMemory or a TaskHistoryEntry", async () => {
    const evidence: BrowserTaskSessionEvidence = {
      version: 1,
      session_id: "task-secret",
      title: "Use OTP 482913",
      task: "Log in with password hunter2 and download the invoice",
      started_at: "2026-10-07T00:00:00.000Z",
      status: "completed",
      start: { tab_id: 1, url: "https://example.com/callback?session_id=abcd1234&code=secretcode99&page=2", title: "Token ghp_abcdefghijklmnopqrstuvwxyz123456" },
      actions: [
        action("action-1", {
          tool: "type",
          target: { element_id: "@e1", tag: "input", role: "textbox", accessible_name: "OTP 482913" },
          after: { tab_id: 1, url: "https://me:hunter2@example.com/done#access_token=abc", title: "Done" }
        }),
        action("action-2", { tool: "click", target: { element_id: "@e2", tag: "input", role: "textbox", accessible_name: "Password" } })
      ],
      tab_evidence: []
    };
    const episode = await saveTaskEpisodeMemory(evidence, SPACE);
    await saveTaskHistoryEntry(
      {
        task: "Log in with password hunter2",
        result: "Signed in. The token is ghp_abcdefghijklmnopqrstuvwxyz123456. The invoice is ready.",
        url: "https://example.com/callback?session_id=abcd1234&code=secretcode99&page=2",
        session_id: "task-secret"
      },
      SPACE
    );
    const stored = JSON.stringify([local[TASK_EPISODE_MEMORY_KEY], local[`browserharness.taskHistory@${SPACE}`]]);
    for (const secret of ["hunter2", "482913", "ghp_", "abcd1234", "secretcode99", "access_token"]) expect(stored).not.toContain(secret);
    expect(episode.targets).toEqual(["Password"]);
    expect(episode.start.url).toBe("https://example.com/callback?page=2");
    const [entry] = await loadTaskHistory(SPACE);
    expect(entry.url).toBe("https://example.com/callback?page=2");
    expect(entry.result).toBe("Signed in. (left out: it looked like a secret) The invoice is ready.");
    expect(entry.task).toBe("(left out: it looked like a secret)");
    expect(episode.sensitive_payloads_removed).toBe(true);
  });

  it("keep ordinary task text, labels, IDs and order numbers readable", async () => {
    for (const text of ["Compare Vendor A pricing", "Submit monthly expense report", "Checkout button", "Product ID B0C12345", "Order #123456", "Password", "OTP", "API key"]) {
      expect(redactSecrets(text)).toBe(text);
    }
    await saveTaskHistoryEntry({ task: "Submit monthly expense report", result: "Submitted. Order #123456 for Product ID B0C12345.", url: "https://shop.example/orders?page=2" }, SPACE);
    const [entry] = await loadTaskHistory(SPACE);
    expect(entry).toMatchObject({ task: "Submit monthly expense report", result: "Submitted. Order #123456 for Product ID B0C12345.", url: "https://shop.example/orders?page=2" });
    expect(entry.session_id).toBeUndefined();
  });
});
