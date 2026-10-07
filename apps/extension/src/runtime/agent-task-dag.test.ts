// Memory v2, Phase 8: the real `agent` tool path for a Task DAG. Every node,
// verifier included, is launched as a read-only worker in the parent task's
// Space, whatever the DAG input says, and the result keeps the node lineage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserEngineDependencies } from "./browser-engine";
import type { ReadOnlySubagentDependencies } from "./subagent-runner";
import type { TaskDagResult } from "./task-dag";

let dagResult: TaskDagResult | null = null;
const workers: Array<{ task: string; mode: string | undefined; sessionId: string; maxSteps: number | undefined }> = [];
const messages: Array<Record<string, unknown>> = [];

vi.mock("./browser-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("./browser-engine")>();
  return {
    ...original,
    runBrowserTask: vi.fn(async (task: string, dependencies: BrowserEngineDependencies) => {
      const result = await dependencies.tool("agent", {
        act: true,
        dag: [
          { id: "research-1", task: "Find the vendor's price", act: true, mode: "act" },
          { id: "verify-1", task: "Check the price claim", type: "verify", dependencies: ["research-1"], act: true, mode: "act", step_budget: 99 }
        ]
      });
      dagResult = result.data as TaskDagResult;
      const evidence = { version: 1, session_id: "task-1", title: task, task, started_at: "2026-10-07T00:00:00.000Z", status: "completed", start: { tab_id: 1, url: "https://shop.example", title: "Shop" }, actions: [], tab_evidence: [] };
      return { status: "completed", message: "done", session_evidence: evidence, steps: 1 };
    })
  };
});

vi.mock("./subagent-runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("./subagent-runner")>();
  return {
    ...original,
    runReadOnlySubagent: vi.fn(async (task: string, dependencies: ReadOnlySubagentDependencies, _signal?: AbortSignal, maxSteps?: number) => {
      workers.push({ task, mode: dependencies.mode, sessionId: dependencies.session.id, maxSteps });
      await dependencies.baseTool("read_page", {});
      const verifying = task.includes("independent read-only VERIFIER");
      return {
        status: "completed",
        message: verifying ? "VERDICT: contradicted. The page lists a different price." : "Claim: the price is $5.",
        steps: 1,
        session_id: dependencies.session.id,
        sources: [{ url: verifying ? "https://regulator.example/" : "https://vendor.example/", title: "Page" }],
        tools_used: ["read_page"]
      };
    })
  };
});

import { runAgentTask } from "./agent-task";

beforeEach(() => {
  dagResult = null;
  workers.length = 0;
  messages.length = 0;
  const local: Record<string, unknown> = {};
  const area = {
    get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).filter((name) => name in local).map((name) => [name, structuredClone(local[name])])),
    set: async (value: Record<string, unknown>) => void Object.assign(local, structuredClone(value)),
    remove: async () => undefined
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: { local: area, session: area },
      runtime: {
        sendMessage: async (message: Record<string, unknown>) => {
          messages.push(message);
          return { ok: true, data: {} };
        }
      }
    }
  });
});

describe("Task DAG through the agent tool", () => {
  it("runs research and verifier as read-only workers in the task's Space and returns their lineage", async () => {
    const recorded: string[] = [];
    const model = { id: "m", label: "m", provider: "openai-compatible", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", chatHealth: { status: "healthy" }, agentHealth: { status: "healthy" }, embeddingHealth: { status: "unknown" } } as never;
    await runAgentTask("compare vendor prices", {
      agentPrimary: model,
      agentFallback: null,
      session: { id: "task-1", title: "vendors" },
      spaceId: "space-work",
      memorySource: { relevantEpisodes: async () => ({ episodes: [], walled: 0 }) } as never,
      memoryWriter: { recordTaskEpisode: async (_evidence: unknown, spaceId: string) => void recorded.push(spaceId) } as never,
      signal: new AbortController().signal,
      hooks: {
        addActivity: () => "a",
        finishActivity: () => undefined,
        isCancelled: () => false,
        isPaused: () => false,
        approvalQuestion: () => null,
        requestApproval: async () => true,
        requestUserAction: async () => true
      } as never
    });

    expect(workers).toHaveLength(2);
    // Neither node can be made to act: not by `act` on the call, nor on a node, nor by `mode`.
    expect(workers.map((worker) => worker.mode)).toEqual(["read", "read"]);
    expect(workers.every((worker) => (worker.maxSteps ?? 0) <= 8)).toBe(true);
    expect(workers[1].task).toContain("independent read-only VERIFIER");
    // Both workers are children of the parent task and work in its Space.
    expect(workers.every((worker) => worker.sessionId.startsWith("task-1:worker:"))).toBe(true);
    const workerMessages = messages.filter((message) => String(message.session_id).startsWith("task-1:worker:"));
    expect(workerMessages.length).toBe(2);
    expect(workerMessages.every((message) => message.space_id === "space-work")).toBe(true);
    expect(recorded).toEqual(["space-work"]);

    const [research, verify] = dagResult!.nodes;
    expect(research).toMatchObject({ id: "research-1", status: "completed", child_session_id: workers[0].sessionId });
    expect(verify).toMatchObject({ id: "verify-1", status: "completed", verdict: "contradicted", dependencies: ["research-1"], child_session_id: workers[1].sessionId });
    expect(verify.provenance).toMatchObject({ depends_on: ["research-1"], sources: [{ url: "https://regulator.example/", title: "Page" }] });
  });
});
