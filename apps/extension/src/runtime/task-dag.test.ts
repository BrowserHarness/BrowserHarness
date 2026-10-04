import { describe, expect, it } from "vitest";
import {
  parseTaskDag,
  parseVerifierVerdict,
  buildDagWorkerTask,
  runTaskDag,
  selectReadyNodes,
  createTaskDagState,
  type TaskDagNodeSpec
} from "./task-dag";
import type { ReadOnlySubagentFinding } from "./subagent-runner";

const finding = (
  id: string,
  over: Partial<ReadOnlySubagentFinding> = {}
): ReadOnlySubagentFinding => ({
  status: "completed",
  message: `done ${id}`,
  steps: 1,
  session_id: `s-${id}`,
  sources: [{ url: `https://x/${id}`, title: id }],
  tools_used: [],
  ...over
});

const spec = (
  id: string,
  deps: string[] = [],
  type: "research" | "verify" = "research"
): TaskDagNodeSpec => ({
  id,
  task: `task ${id}`,
  type,
  dependencies: deps,
  step_budget: 8
});

describe("parseTaskDag", () => {
  it("accepts a valid DAG and bounds step budgets", () => {
    const result = parseTaskDag([
      { id: "a", task: "A", step_budget: 99 },
      { id: "v", task: "V", type: "verify", dependencies: ["a"] }
    ]);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.nodes[0].step_budget).toBe(8);
      expect(result.nodes[0].type).toBe("research");
    }
  });

  it.each([
    ["empty", [], "DAG_NODES_REQUIRED"],
    [
      "too many",
      ["a", "b", "c", "d", "e"].map((id) => ({ id, task: id })),
      "DAG_NODE_LIMIT"
    ],
    [
      "duplicate",
      [{ id: "a", task: "A" }, { id: "a", task: "B" }],
      "DAG_NODE_DUPLICATE"
    ],
    [
      "unknown dep",
      [{ id: "a", task: "A", dependencies: ["z"] }],
      "DAG_UNKNOWN_DEPENDENCY"
    ],
    [
      "self dep",
      [{ id: "a", task: "A", dependencies: ["a"] }],
      "DAG_CYCLE"
    ],
    [
      "cycle",
      [
        { id: "a", task: "A", dependencies: ["b"] },
        { id: "b", task: "B", dependencies: ["a"] }
      ],
      "DAG_CYCLE"
    ],
    [
      "verifier without claim",
      [{ id: "v", task: "V", type: "verify" }],
      "DAG_VERIFIER_NEEDS_CLAIM"
    ],
    [
      "bad type",
      [{ id: "a", task: "A", type: "write" }],
      "DAG_NODE_TYPE"
    ]
  ])("rejects %s", (_name, input, code) => {
    const result = parseTaskDag(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe("scheduler", () => {
  it("picks ready nodes in order, capped at two", () => {
    const nodes = createTaskDagState([spec("a"), spec("b"), spec("c")]);
    expect(selectReadyNodes(nodes).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("runs dependents only after prerequisites and never exceeds two workers", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const result = await runTaskDag(
      [spec("a"), spec("b"), spec("c"), spec("v", ["a", "b"], "verify")],
      async ({ node, prerequisites }) => {
        active++;
        peak = Math.max(peak, active);
        order.push(`start:${node.id}:${prerequisites.map((p) => p.id)}`);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return finding(node.id, {
          message: node.type === "verify" ? "VERDICT: supported" : "ok"
        });
      }
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(order.indexOf("start:v:a,b")).toBeGreaterThan(
      order.indexOf("start:b:")
    );
    expect(result.completed_count).toBe(4);
    const verifier = result.nodes.find((n) => n.id === "v")!;
    expect(verifier.verdict).toBe("supported");
    expect(verifier.provenance).toMatchObject({
      node_id: "v",
      depends_on: ["a", "b"],
      session_id: "s-v"
    });
  });

  it("blocks dependents of a failed prerequisite but keeps independent work", async () => {
    const result = await runTaskDag(
      [spec("a"), spec("b"), spec("v", ["a"], "verify")],
      async ({ node }) =>
        node.id === "a"
          ? Promise.reject(new Error("boom"))
          : finding(node.id)
    );
    const by = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
    expect(by.a.status).toBe("failed");
    expect(by.a.finding?.message).toBe("boom");
    expect(by.v.status).toBe("blocked");
    expect(by.v.blocked_by).toBe("a");
    expect(by.b.status).toBe("completed");
  });

  it("treats a non-completed finding as failure", async () => {
    const result = await runTaskDag([spec("a"), spec("b", ["a"])], async ({ node }) =>
      finding(node.id, { status: "stopped" })
    );
    expect(result.nodes.map((n) => n.status)).toEqual(["failed", "blocked"]);
  });

  it("cancellation aborts children and cancels pending nodes", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const promise = runTaskDag(
      [spec("a"), spec("b", ["a"])],
      ({ node, signal }) => {
        seen.push(signal);
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve(finding(node.id, { status: "stopped" }))
          );
        });
      },
      controller.signal
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(seen[0]).toBe(controller.signal);
    expect(result.nodes.map((n) => n.status)).toEqual(["failed", "cancelled"]);
  });

  it("is deterministic across runs", async () => {
    const run = () =>
      runTaskDag([spec("a"), spec("b"), spec("c", ["a"])], async ({ node }) =>
        finding(node.id)
      ).then((r) => r.nodes.map((n) => `${n.id}:${n.status}`));
    expect(await run()).toEqual(await run());
  });
});

describe("parseVerifierVerdict", () => {
  it("reads explicit verdicts and defaults to insufficient", () => {
    expect(parseVerifierVerdict("VERDICT: contradicted - page says no")).toBe("contradicted");
    expect(parseVerifierVerdict("verdict=Supported")).toBe("supported");
    expect(parseVerifierVerdict("looks fine to me")).toBe("insufficient");
  });
});

describe("buildDagWorkerTask", () => {
  it("gives verifiers the claims and the verdict contract", () => {
    const prereq = {
      ...createTaskDagState([spec("a")])[0],
      status: "completed" as const,
      finding: finding("a", { message: "Price is $5" })
    };
    const text = buildDagWorkerTask(spec("v", ["a"], "verify"), [prereq]);
    expect(text).toContain("Price is $5");
    expect(text).toContain("https://x/a");
    expect(text).toContain("VERDICT: supported");
  });
  it("leaves research nodes without prerequisites unchanged", () => {
    expect(buildDagWorkerTask(spec("a"), [])).toBe("task a");
  });
});
