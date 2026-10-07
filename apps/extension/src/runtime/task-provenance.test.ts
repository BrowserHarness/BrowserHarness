// Memory v2, Phase 8: task, helper and verifier provenance. A Task DAG run by
// a task survives into its saved episode with every node, edge, session,
// source and verdict as it really ended; recall shows a claim only with its
// verdict; nothing crosses a Space; nothing secret is kept.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBrowserTask, type BrowserEngineDependencies } from "./browser-engine";
import { nextAgentDecision, type AgentDecision } from "./model-client";
import type { PageObservation, ToolResult } from "./protocol";
import type { BrowserTaskSessionEvidence } from "./session-evidence";
import type { ReadOnlySubagentFinding } from "./subagent-runner";
import { readOnlyWorkerToolPolicy, workerToolPolicy } from "./subagent-policy";
import { dagWorkerSpec, parseTaskDag, runTaskDag, type TaskDagNodeSpec, type TaskDagResult } from "./task-dag";
import {
  saveTaskEpisodeMemory,
  searchTaskEpisodeMemory,
  taskEpisodeFromSession,
  TASK_EPISODE_MEMORY_KEY,
  type TaskEpisodeMemory
} from "./task-memory";
import { dagEvidenceFromResult, findingSummary, safeSourceUrl, verificationSummary } from "./task-provenance";
import { taskEpisodeEmbeddingText } from "./semantic-memory";
import { compileContext, renderContext } from "./context";
import { loadAboutMe, loadGlobalAboutMe } from "./about-me";
import { currentDecisions } from "./decisions";
import { loadGlobalInstructions, loadInstructions } from "./instructions";

let local: Record<string, unknown>;
function area(store: () => Record<string, unknown>) {
  return {
    get: async (key: string | string[] | null) => {
      if (key === null || key === undefined) return structuredClone(store());
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
    value: { storage: { local: area(() => local), session: area(() => ({})) }, runtime: { sendMessage: async () => ({ ok: true, data: {} }) } }
  });
});

const spec = (id: string, task: string, type: "research" | "verify" = "research", dependencies: string[] = []): TaskDagNodeSpec => ({
  id,
  task,
  type,
  dependencies,
  step_budget: 8
});

let runs = 0;
type Answer = Partial<ReadOnlySubagentFinding> | Error;

/** A real Task DAG run with scripted workers. */
async function dag(specs: TaskDagNodeSpec[], answers: Record<string, Answer>, signal?: AbortSignal): Promise<TaskDagResult> {
  return runTaskDag(
    specs,
    async ({ node }) => {
      const answer = answers[node.id] ?? {};
      if (answer instanceof Error) throw answer;
      return {
        status: "completed",
        message: `${node.id} done`,
        steps: 2,
        session_id: `parent-1:worker:${node.id}`,
        sources: [],
        tools_used: ["open_tab", "read_page"],
        ...answer
      };
    },
    signal
  );
}

function page(): PageObservation {
  return { tab_id: 1, url: "https://shop.example/vendors", title: "Vendors", visible_text: "Vendors", elements: [], adapter: "generic-web" };
}

/** A real parent browser task that makes one `agent` call and gets `data` back. */
async function parentRun(input: Record<string, unknown>, data: unknown, task = "Compare vendor claims"): Promise<BrowserTaskSessionEvidence> {
  const decisions: AgentDecision[] = [
    { kind: "tool", tool: "agent", input, note: "Delegating" },
    { kind: "final", message: "Done." }
  ];
  let index = 0;
  // Each run its own start time, so two runs never share an episode id.
  runs += 1;
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 7, 0, 0, runs)));
  const dependencies: BrowserEngineDependencies = {
    session: { id: "parent-1", title: task },
    decide: async () => ({ decision: decisions[index++] }),
    tool: (async (name: string) =>
      name === "observe_page" ? { ok: true, data: page() } : name === "agent" ? ({ ok: true, data } as ToolResult) : { ok: true, data: {} }) as BrowserEngineDependencies["tool"],
    approvalDescription: () => null,
    requestApproval: async () => true,
    isCancelled: () => false,
    waitWhilePaused: async () => undefined,
    withActivity: async (_label, operation) => operation()
  };
  const result = await runBrowserTask(task, dependencies);
  return result.session_evidence;
}

const research = (claim: string, url: string): Answer => ({
  message: claim,
  sources: [{ url, title: "Vendor page" }]
});
const verifier = (message: string, url: string): Answer => ({
  message,
  sources: [{ url, title: "Regulator" }]
});

async function vendorEpisode(verdictLine: string, spaceId = "space-a"): Promise<TaskEpisodeMemory> {
  const result = await dag(
    [spec("research-1", "Find what Vendor A says about pricing"), spec("verify-1", "Check the pricing claim from research-1", "verify", ["research-1"])],
    {
      "research-1": research("Vendor A pricing is free for all users.", "https://vendor-a.example/pricing"),
      "verify-1": verifier(`${verdictLine}\nThe regulator page lists a paid plan.`, "https://regulator.example/vendor-a")
    }
  );
  return saveTaskEpisodeMemory(await parentRun({ dag: [] }, result), spaceId);
}

const nodeOf = (episode: TaskEpisodeMemory, id: string) => episode.dag_runs![0].nodes.find((node) => node.node_id === id)!;

describe("Task DAG persistence", () => {
  it("keeps research and verify nodes, the edge, both sessions, both source lists and the verdict", async () => {
    const episode = await vendorEpisode("VERDICT: supported");
    const run = episode.dag_runs![0];
    expect(run).toMatchObject({ action_id: "action-1", parent_session_id: "parent-1", completed_count: 2, cancelled: false });
    expect(episode.space_id).toBe("space-a");
    expect(nodeOf(episode, "research-1")).toMatchObject({
      type: "research",
      status: "completed",
      mode: "read",
      child_session_id: "parent-1:worker:research-1",
      depends_on: [],
      sources: [{ url: "https://vendor-a.example/pricing", title: "Vendor page" }],
      tools_used: ["open_tab", "read_page"],
      finding: "Vendor A pricing is free for all users.",
      checked_by: [{ node_id: "verify-1", status: "completed", verdict: "supported" }],
      trust: { sources: "observed", finding: "derived" }
    });
    expect(nodeOf(episode, "verify-1")).toMatchObject({
      type: "verify",
      child_session_id: "parent-1:worker:verify-1",
      depends_on: ["research-1"],
      sources: [{ url: "https://regulator.example/vendor-a", title: "Regulator" }],
      verdict: "supported",
      trust: { sources: "observed", finding: "derived", verdict: "derived_verification" }
    });
    // The verdict line is the verdict, not part of the summary.
    expect(nodeOf(episode, "verify-1").finding).toBe("The regulator page lists a paid plan.");
    // A DAG is not squeezed into the worker list.
    expect(episode.delegations).toBeUndefined();
    expect(episode.sites).toEqual(expect.arrayContaining(["https://vendor-a.example", "https://regulator.example"]));
  });

  it("persists exactly supported, contradicted and insufficient", async () => {
    expect(nodeOf(await vendorEpisode("VERDICT: supported"), "verify-1").verdict).toBe("supported");
    expect(nodeOf(await vendorEpisode("VERDICT: contradicted"), "verify-1").verdict).toBe("contradicted");
    // No verdict line at all: insufficient, as the scheduler decides.
    expect(nodeOf(await vendorEpisode("I looked around but could not tell."), "verify-1").verdict).toBe("insufficient");
    expect(nodeOf(await vendorEpisode("VERDICT: probably fine"), "verify-1").verdict).toBe("insufficient");
  });

  it("keeps both edges of a verifier that checks two research nodes, in order", async () => {
    const result = await dag(
      [spec("research-a", "Price of A"), spec("research-b", "Price of B"), spec("verify-final", "Check both prices", "verify", ["research-a", "research-b"])],
      { "verify-final": { message: "VERDICT: contradicted" } }
    );
    const episode = taskEpisodeFromSession(await parentRun({ dag: [] }, result), undefined, "space-a");
    expect(nodeOf(episode, "verify-final").depends_on).toEqual(["research-a", "research-b"]);
    expect(nodeOf(episode, "research-a").checked_by).toEqual([{ node_id: "verify-final", status: "completed", verdict: "contradicted" }]);
    expect(nodeOf(episode, "research-b").checked_by).toEqual([{ node_id: "verify-final", status: "completed", verdict: "contradicted" }]);
  });

  it("records a blocked verifier with blocked_by and no session, sources or verdict", async () => {
    const result = await dag([spec("research-1", "Find the claim"), spec("verify-1", "Check it", "verify", ["research-1"])], {
      "research-1": new Error("site unreachable")
    });
    const episode = taskEpisodeFromSession(await parentRun({ dag: [] }, result), undefined, "space-a");
    const failed = nodeOf(episode, "research-1");
    const blocked = nodeOf(episode, "verify-1");
    expect(failed.status).toBe("failed");
    // A worker that threw has only a placeholder id; no session is made up for it.
    expect(failed.child_session_id).toBeUndefined();
    expect(failed.finding).toBeUndefined();
    expect(blocked).toMatchObject({ status: "blocked", blocked_by: "research-1", sources: [], tools_used: [] });
    expect(blocked.verdict).toBeUndefined();
    expect(blocked.child_session_id).toBeUndefined();
    expect(failed.checked_by).toEqual([{ node_id: "verify-1", status: "blocked" }]);
    expect(episode.dag_runs![0]).toMatchObject({ failed_count: 1, blocked_count: 1, completed_count: 0 });
  });

  it("keeps a cancelled DAG's real states only", async () => {
    const controller = new AbortController();
    const running = runTaskDag(
      [spec("research-1", "Slow research"), spec("verify-1", "Check it", "verify", ["research-1"])],
      ({ node, signal }) =>
        new Promise<ReadOnlySubagentFinding>((resolve) =>
          signal?.addEventListener("abort", () =>
            resolve({ status: "stopped", message: "Stopped.", steps: 1, session_id: `parent-1:worker:${node.id}`, sources: [{ url: "https://slow.example/", title: "Slow" }], tools_used: ["read_page"] })
          )
        ),
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const episode = taskEpisodeFromSession(await parentRun({ dag: [] }, await running), undefined, "space-a");
    const run = episode.dag_runs![0];
    expect(run.cancelled).toBe(true);
    // The research worker really ran and was stopped; the verifier never started.
    expect(nodeOf(episode, "research-1")).toMatchObject({ status: "failed", worker_status: "stopped", child_session_id: "parent-1:worker:research-1", sources: [{ url: "https://slow.example/", title: "Slow" }] });
    expect(nodeOf(episode, "research-1").finding).toBeUndefined();
    expect(nodeOf(episode, "verify-1")).toMatchObject({ status: "cancelled", sources: [] });
    expect(nodeOf(episode, "verify-1").verdict).toBeUndefined();
    expect(nodeOf(episode, "verify-1").child_session_id).toBeUndefined();
    expect(run.nodes.some((node) => node.status === "completed")).toBe(false);
    expect(run).toMatchObject({ completed_count: 0, failed_count: 1, cancelled_count: 1 });
  });

  it("never stores a verdict for a research node or a failed verifier", () => {
    const dagEvidence = dagEvidenceFromResult({
      nodes: [
        { id: "r", task: "Research", type: "research", dependencies: [], status: "completed", verdict: "supported", child_session_id: "s-r", finding: { status: "completed", message: "x", session_id: "s-r", sources: [], tools_used: [] } },
        { id: "v", task: "Verify", type: "verify", dependencies: ["r"], status: "failed", verdict: "supported", child_session_id: "s-v", finding: { status: "stopped", message: "VERDICT: supported", session_id: "s-v", sources: [], tools_used: [] } }
      ],
      cancelled: false
    })!;
    expect(dagEvidence.nodes[0].verdict).toBeUndefined();
    expect(dagEvidence.nodes[1].verdict).toBeUndefined();
    expect(dagEvidence.nodes[1].worker_status).toBe("stopped");
  });
});

describe("Ordinary helper batches", () => {
  const batch = (mode?: "read" | "act") => ({
    ...(mode ? { mode } : {}),
    worker_count: 4,
    completed_count: 4,
    non_completed_count: 0,
    workers: [1, 2, 3, 4].map((n) => ({
      index: n - 1,
      task: `Read source ${n}`,
      finding: { status: "completed", message: `Found ${n}`, steps: 1, session_id: `parent-1:worker:${n}`, sources: [{ url: `https://s${n}.example/a`, title: `S${n}` }], tools_used: ["read_page"] }
    })),
    sources: []
  });

  it("still keeps every worker of a read-only batch, with its parent and action", async () => {
    const episode = taskEpisodeFromSession(await parentRun({ tasks: ["a", "b", "c", "d"] }, batch("read")), undefined, "space-a");
    expect(episode.dag_runs).toBeUndefined();
    expect(episode.delegations).toHaveLength(4);
    expect(episode.delegations![3]).toMatchObject({
      action_id: "action-1",
      worker_index: 3,
      task: "Read source 4",
      session_id: "parent-1:worker:4",
      status: "completed",
      sources: [{ url: "https://s4.example/a", title: "S4" }],
      parent_session_id: "parent-1",
      trust: "observed",
      mode: "read"
    });
  });

  it("marks acting helpers as act, from how they were launched", async () => {
    const acting = taskEpisodeFromSession(await parentRun({ tasks: ["a", "b"], act: true }, batch("act")), undefined, "space-a");
    expect(acting.delegations!.every((item) => item.mode === "act")).toBe(true);
    // An older result with no mode: the call's own act flag decides, never the tools used.
    const older = taskEpisodeFromSession(await parentRun({ tasks: ["a"], act: true }, batch()), undefined, "space-a");
    expect(older.delegations![0].mode).toBe("act");
    const read = taskEpisodeFromSession(await parentRun({ tasks: ["a"] }, batch()), undefined, "space-a");
    expect(read.delegations![0].mode).toBe("read");
  });
});

describe("Verifiers stay read-only workers", () => {
  it("drops act or mode fields from DAG input; a node's worker spec never asks to act", () => {
    const parsed = parseTaskDag([
      { id: "r", task: "Research", act: true, mode: "act" },
      { id: "v", task: "Verify", type: "verify", dependencies: ["r"], act: true, mode: "act", tools: ["click"] }
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const node of parsed.nodes) {
      expect(Object.keys(node).sort()).toEqual(["dependencies", "id", "step_budget", "task", "type"]);
      const workerSpec = dagWorkerSpec(node, []);
      expect(Object.keys(workerSpec).sort()).toEqual(["max_steps", "task"]);
    }
  });

  it("stores every DAG node as read, whatever the result claims", async () => {
    const result = await dag([spec("r", "Research"), spec("v", "Verify", "verify", ["r"])], { v: { message: "VERDICT: supported" } });
    const tampered = { ...result, mode: "act", nodes: result.nodes.map((node) => ({ ...node, mode: "act", act: true })) };
    const episode = taskEpisodeFromSession(await parentRun({ dag: [], act: true }, tampered), undefined, "space-a");
    expect(episode.dag_runs![0].nodes.every((node) => node.mode === "read")).toBe(true);
  });

  it("denies a read-only worker clicking, typing and starting more agents", () => {
    const state = { owned_tab_ids: new Set<number>([7]), current_owned_tab_id: 7 };
    for (const tool of ["click", "type", "press_key", "agent", "upload", "evaluate", "cdp"] as const) {
      expect(readOnlyWorkerToolPolicy(tool, { tab_id: 7 }, state).allowed).toBe(false);
      expect(workerToolPolicy("read", tool, { tab_id: 7 }, state).allowed).toBe(false);
    }
    // Even an acting helper can never start more agents.
    expect(workerToolPolicy("act", "agent", {}, state).allowed).toBe(false);
  });
});

describe("Space wall", () => {
  it("never finds, lists or compiles a DAG episode from another Space", async () => {
    await vendorEpisode("VERDICT: contradicted", "space-a");
    expect(await searchTaskEpisodeMemory("contradicted verifier pricing", 10, "space-a")).toHaveLength(1);
    expect(await searchTaskEpisodeMemory("contradicted verifier pricing", 10, "space-b")).toHaveLength(0);
    const compiled = await compileContext({ request: "What did the verifier say about Vendor A pricing?", spaceId: "space-b", intent: "chat" });
    expect(compiled.sections.episodes ?? []).toHaveLength(0);
    expect(renderContext(compiled)).not.toContain("Vendor A");
    expect(compiled.diagnostics.excluded.some((item) => item.reason === "another Space")).toBe(true);
  });
});

describe("Search", () => {
  beforeEach(async () => {
    await vendorEpisode("VERDICT: contradicted", "space-a");
    await saveTaskEpisodeMemory(await parentRun({ tasks: ["Look up kettle prices"] }, {
      worker_count: 1, completed_count: 1, non_completed_count: 0,
      workers: [{ index: 0, task: "Look up kettle prices", finding: { status: "completed", message: "ok", steps: 1, session_id: "w", sources: [{ url: "https://kettles.example/", title: "Kettles" }], tools_used: ["read_page"] } }]
    }, "Buy a kettle"), "space-a");
  });

  it("finds the contradicted task, the verifier's subject, the sources and the node", async () => {
    const top = async (query: string) => (await searchTaskEpisodeMemory(query, 5, "space-a"))[0]?.task;
    expect(await top("Which task was contradicted?")).toBe("Compare vendor claims");
    expect(await top("What did the verifier say about pricing?")).toBe("Compare vendor claims");
    expect(await top("Which sources checked this? regulator.example")).toBe("Compare vendor claims");
    expect(await top("research-1")).toBe("Compare vendor claims");
    expect(await top("kettle prices")).toBe("Buy a kettle");
  });

  it("puts DAG nodes in the meaning index text only for episodes that ran one", async () => {
    const [kettle, vendor] = [...(local[TASK_EPISODE_MEMORY_KEY] as TaskEpisodeMemory[])];
    expect(taskEpisodeEmbeddingText(vendor)).toContain("verification: research-1 research");
    expect(taskEpisodeEmbeddingText(vendor)).toContain("contradicted");
    expect(taskEpisodeEmbeddingText(kettle)).not.toContain("verification:");
  });
});

describe("Context Compiler recall", () => {
  it("shows a contradicted claim only as contradicted", async () => {
    await vendorEpisode("VERDICT: contradicted");
    const compiled = await compileContext({ request: "Is Vendor A pricing free?", spaceId: "space-a", intent: "chat" });
    const text = renderContext(compiled);
    expect(text).toContain("Vendor A pricing is free for all users.");
    expect(text).toMatch(/Checked “Vendor A pricing is free for all users\.”: CONTRADICTED when checked: treat it as wrong, not as a fact/);
    // The claim never appears without its verdict next to it.
    for (const line of text.split("\n").filter((line) => line.includes("free for all users"))) expect(line).toContain("CONTRADICTED");
    expect(compiled.sections.episodes![0]).toMatchObject({ authority: "past_task", temporal: "historical", trust: "observed" });
  });

  it("says an insufficient check was inconclusive", async () => {
    await vendorEpisode("Could not find anything either way.");
    const text = renderContext(await compileContext({ request: "Was Vendor A pricing confirmed?", spaceId: "space-a", intent: "chat" }));
    expect(text).toContain("could not be confirmed when checked (inconclusive)");
    expect(text).not.toMatch(/free for all users\.”: supported/);
  });

  it("says a supported claim was true at that time, ranks it a little higher, and adds checks only when they help", async () => {
    await vendorEpisode("VERDICT: supported");
    const compiled = await compileContext({ request: "Is Vendor A pricing free?", spaceId: "space-a", intent: "chat" });
    expect(renderContext(compiled)).toContain("supported by the sources checked then (true at that time; may have changed)");
    expect(compiled.sections.episodes![0].reason).toContain("verifier");
    // Asked about the task itself, not what was checked: the past task comes without verifier detail.
    const plain = await compileContext({ request: "compare offers", spaceId: "space-a", intent: "chat" });
    expect(plain.sections.episodes![0].reason).not.toContain("verifier");
    expect(renderContext(plain)).not.toContain("Checked");
    expect(compiled.sections.episodes![0].relevance).toBeGreaterThan(plain.sections.episodes![0].relevance);
  });

  it("keeps verifier history out of unrelated requests", async () => {
    await vendorEpisode("VERDICT: contradicted");
    const compiled = await compileContext({ request: "Write a short poem about the sea", spaceId: "space-a", intent: "chat" });
    expect(compiled.sections.episodes ?? []).toHaveLength(0);
    expect(renderContext(compiled)).not.toMatch(/CONTRADICTED|Vendor A/);
  });

  it("keeps the past task below the current request and conversation", async () => {
    await vendorEpisode("VERDICT: supported");
    const compiled = await compileContext({
      request: "Is Vendor A pricing free? The page I have open now shows a paid plan.",
      spaceId: "space-a",
      intent: "chat",
      conversation: [{ role: "user", text: "Vendor A changed its pricing page today." }]
    });
    const episode = compiled.sections.episodes![0];
    const request = compiled.sections.request?.[0];
    expect(episode.authority).toBe("past_task");
    if (request) expect(request.authority).toBe("request");
    const text = renderContext(compiled);
    expect(text).toContain("My message above comes first");
    expect(text).toContain("not checked again now");
  });

  it("gives the browser agent the verdict with the claim, after the live page, with fresh evidence winning", async () => {
    const episode = await vendorEpisode("VERDICT: contradicted");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "final", message: "Done" }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    try {
      await nextAgentDecision({ provider: "nvidia", apiKey: "nvapi-test", model: "meta/test-chat", baseUrl: "https://integrate.api.nvidia.com/v1" }, "Check Vendor A pricing", page(), [], undefined, [], undefined, [episode]);
      const prompt = String(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[1].content);
      expect(prompt.indexOf("CURRENT PAGE OBSERVATION")).toBeLessThan(prompt.indexOf("RELEVANT PAST TASK EPISODES"));
      expect(prompt).toContain('"checked_by":[{"node_id":"verify-1","status":"completed","verdict":"contradicted"}]');
      expect(prompt).toContain("contradicted means the claim was found wrong (never repeat it as true)");
      expect(prompt).toContain("Fresh page evidence now always wins over any past verdict.");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("Verification never becomes personal memory", () => {
  it("leaves facts, decisions and instructions untouched", async () => {
    await vendorEpisode("VERDICT: supported");
    await vendorEpisode("VERDICT: contradicted", "space-b");
    for (const space of ["space-a", "space-b"]) {
      expect(await loadAboutMe(space)).toEqual([]);
      expect(await currentDecisions(space)).toEqual([]);
      expect(await loadInstructions(space)).toBe("");
    }
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect(await loadGlobalInstructions()).toBe("");
    expect(Object.keys(local).filter((key) => key !== TASK_EPISODE_MEMORY_KEY && !key.includes("taskEpisodeVectors"))).toEqual([]);
  });
});

describe("Sensitive data", () => {
  it("cleans credential-bearing URL parameters and keeps ordinary ones", () => {
    expect(safeSourceUrl("https://vendor.example/pricing?plan=pro&page=2")).toBe("https://vendor.example/pricing?plan=pro&page=2");
    expect(safeSourceUrl("https://me:hunter2@vendor.example/a?access_token=abc123&q=kettle#id_token=xyz")).toBe("https://vendor.example/a?q=kettle");
    expect(safeSourceUrl("https://cdn.example/f?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA&name=report")).toBe("https://cdn.example/f?name=report");
    expect(safeSourceUrl("https://login.example/cb?code=482913&state=s1")).toBe("https://login.example/cb");
    expect(safeSourceUrl("https://x.example/?ref=sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("https://x.example/");
    expect(safeSourceUrl("data:text/html,<script>")).toBe("");
    expect(safeSourceUrl("javascript:alert(1)")).toBe("");
  });

  it("keeps no secret tool input, worker text, URL or title in the saved provenance", async () => {
    const result = await dag(
      [spec("research-1", "Log in with password hunter2! and read the plan"), spec("verify-1", "Check the plan", "verify", ["research-1"])],
      {
        "research-1": {
          message: "<think>the api key is sk-proj-abcdefghijklmnopqrstuvwx</think>The plan costs $5. My OTP 482913 worked.",
          sources: [{ url: "https://vendor.example/account?session_id=abcd1234efgh&tab=plan", title: "Account" }]
        },
        "verify-1": { message: "VERDICT: supported. Token: ghp_abcdefghijklmnopqrstuvwxyz123456", sources: [{ url: "https://vendor.example/plan", title: "password is hunter2!" }] }
      }
    );
    const evidence = await parentRun({ dag: [{ id: "research-1", task: "Log in with password hunter2!" }] }, result);
    const episode = await saveTaskEpisodeMemory(evidence, "space-a");
    const saved = JSON.stringify(local[TASK_EPISODE_MEMORY_KEY]);
    for (const secret of ["hunter2", "sk-proj", "482913", "ghp_", "abcd1234efgh", "<think>"]) expect(saved).not.toContain(secret);
    expect(nodeOf(episode, "research-1").task).toBe("(left out: it looked like it held a secret)");
    expect(nodeOf(episode, "research-1").finding).toBeUndefined();
    expect(nodeOf(episode, "research-1").sources[0].url).toBe("https://vendor.example/account?tab=plan");
    expect(nodeOf(episode, "verify-1").sources[0].title).toBe("");
    expect(episode.sensitive_payloads_removed).toBe(true);
  });

  it("keeps findings short, plain and model-derived", () => {
    expect(findingSummary("**Vendor A** says `free`.\n\n> quoted")).toBe("Vendor A says free . quoted");
    const long = findingSummary("word ".repeat(200))!;
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith("…")).toBe(true);
    expect(findingSummary(`Page dump ${"A".repeat(120)}`)).toBeUndefined();
    expect(findingSummary("See https://v.example/a?token=abc123def456 for details")).toBe("See https://v.example/a for details");
  });
});

describe("Bounds and old episodes", () => {
  it("dedupes sources and caps them at six per node, and nodes at four", () => {
    const sources = [...Array(10)].map((_, n) => ({ url: `https://s.example/${n % 8}`, title: "S" }));
    const evidence = dagEvidenceFromResult({
      nodes: [...Array(6)].map((_, n) => ({
        id: `n${n}`, task: "t", type: "research", dependencies: [], status: "completed", child_session_id: `s${n}`,
        finding: { status: "completed", message: "m", session_id: `s${n}`, sources, tools_used: [...Array(30)].map((__, t) => `tool_${String.fromCharCode(97 + (t % 26))}${t}`.replace(/\d/g, "")) }
      })),
      cancelled: false
    })!;
    expect(evidence.nodes).toHaveLength(4);
    expect(evidence.nodes[0].sources).toHaveLength(6);
    expect(new Set(evidence.nodes[0].sources.map((source) => source.url)).size).toBe(6);
    expect(evidence.nodes[0].tools_used.length).toBeLessThanOrEqual(20);
  });

  it("loads, searches and recalls a Phase 7 episode with no DAG fields", async () => {
    const old: TaskEpisodeMemory = {
      schema_version: 1,
      id: "episode:old:1",
      kind: "task_episode",
      recorded_at: "2026-10-05T10:00:00.000Z",
      session_id: "old",
      title: "Compare kettle prices",
      task: "Compare kettle prices on two shops",
      status: "completed",
      start: { tab_id: 1, url: "https://shop.example/", title: "Shop" },
      action_count: 1,
      manual_handoff_count: 0,
      tools: ["agent"],
      targets: [],
      sites: ["https://shop.example"],
      skill_refs: [],
      delegations: [{ action_id: "action-1", worker_index: 0, task: "Kettle A price", session_id: "old:worker:1", status: "completed", sources: [{ url: "https://a.example/", title: "A" }], tools_used: ["read_page"], parent_session_id: "old", trust: "observed" }],
      sensitive_payloads_removed: true,
      space_id: "space-a",
      trust: "observed"
    };
    local[TASK_EPISODE_MEMORY_KEY] = [old];
    const found = await searchTaskEpisodeMemory("kettle prices", 5, "space-a");
    expect(found).toHaveLength(1);
    expect(found[0].dag_runs).toBeUndefined();
    expect(found[0].delegations![0].mode).toBeUndefined();
    expect(verificationSummary(found[0].dag_runs)).toEqual([]);
    const text = renderContext(await compileContext({ request: "Compare kettle prices again", spaceId: "space-a", intent: "chat" }));
    expect(text).toContain("Compare kettle prices on two shops");
    expect(text).toContain("helpers' sources then: https://a.example/");
    expect(text).not.toContain("Checked");
  });

  it("serializes, searches and recalls bounded provenance quickly, and a no-helper task is unchanged", async () => {
    const result = await dag(
      [spec("a", "Research A"), spec("b", "Research B"), spec("v", "Verify both", "verify", ["a", "b"]), spec("w", "Verify A", "verify", ["a"])],
      Object.fromEntries(["a", "b", "v", "w"].map((id) => [id, { message: `VERDICT: supported ${id}`, sources: [...Array(6)].map((_, n) => ({ url: `https://${id}${n}.example/`, title: id })) }]))
    );
    const evidence = await parentRun({ dag: [] }, result);
    const plain = await parentRun({ tasks: [] }, { nope: true }, "Read a page");
    const started = performance.now();
    for (let n = 0; n < 200; n += 1) taskEpisodeFromSession({ ...evidence, session_id: `s${n}` }, undefined, "space-a");
    const serialize = performance.now() - started;
    const episodes = [...Array(500)].map((_, n) => taskEpisodeFromSession({ ...evidence, session_id: `s${n}`, task: `Task ${n} vendor` }, undefined, "space-a"));
    local[TASK_EPISODE_MEMORY_KEY] = episodes;
    const searchStart = performance.now();
    await searchTaskEpisodeMemory("verifier supported vendor", 10, "space-a");
    const search = performance.now() - searchStart;
    const compileStart = performance.now();
    await compileContext({ request: "What did the verifier say about Research A?", spaceId: "space-a", intent: "chat" });
    const compile = performance.now() - compileStart;
    console.info(`phase8 perf: 200 serializations ${serialize.toFixed(1)} ms, search of 500 ${search.toFixed(1)} ms, compile ${compile.toFixed(1)} ms; DAG episode ${JSON.stringify(episodes[0]).length} bytes`);
    expect(serialize).toBeLessThan(500);
    expect(search).toBeLessThan(200);
    expect(compile).toBeLessThan(300);
    // A task with no helpers gets no new fields and the same schema version.
    const plainEpisode = taskEpisodeFromSession(plain, "2026-10-07T00:00:00.000Z", "space-a");
    expect(plainEpisode.schema_version).toBe(1);
    expect("dag_runs" in plainEpisode || "delegations" in plainEpisode).toBe(false);
  });
});

vi.setConfig({ testTimeout: 20000 });
