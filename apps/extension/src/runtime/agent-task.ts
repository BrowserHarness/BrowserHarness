// One browser task run by the agent: the model decides, tools act, workers
// and Task DAGs fan out, and the run is saved to memory. Shared by the side
// panel and by scheduled tasks, which supply their own hooks for approvals,
// hand-offs and progress.
import { approvalFor } from "./approval-mode";
import {
  runBrowserTask,
  type BrowserEngineResult,
  type BrowserToolExecution,
  type BrowserEngineDependencies
} from "./browser-engine";
import type { ApprovalMode } from "../settings/preferences";
import { markBrowserReady, type ProviderConnection } from "../settings/provider-store";
import {
  agentDecisionWithFallback,
  readOnlyWorkerDecisionWithFallback
} from "./model-router";
import type { PageObservation, ToolName, ToolResult } from "./protocol";
import type { MemorySource } from "./context/memory-source";
import type { MemoryWriter } from "./memory-write/writer";
import { searchProceduralMemory } from "./procedural-memory";
import { discoverMcpCatalog as buildMcpCatalog } from "./mcp-catalog";
import { getMcpServerTrustMode } from "../settings/mcp-trust-store";
import { clearBrowserWorkingMemory, saveBrowserWorkingMemory } from "./working-memory";
import { runReadOnlySubagent } from "./subagent-runner";
import { buildDagWorkerTask, parseTaskDag, runTaskDag } from "./task-dag";
import { parseReadOnlySubagentTasks, runReadOnlySubagentBatch } from "./subagent-supervisor";

export const APPROVAL_WORDS =
  /\b(send|submit|publish|buy|purchase|checkout|place order|pay|delete|remove|change password|security)\b/i;

export async function extensionMessage<T>(request: unknown): Promise<ToolResult<T>> {
  return chrome.runtime.sendMessage(request);
}

export function safeHostname(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The question to ask before a risky action, or null when none is needed. */
export function riskyActionQuestion(
  observation: PageObservation,
  tool: string,
  input: Record<string, unknown>
) {
  const id = input.element_id;
  const element =
    typeof id === "string"
      ? observation.elements.find((candidate) => candidate.element_id === id)
      : undefined;
  const host = safeHostname(observation.url) || "this page";

  if (tool === "click" && element) {
    if (element.requires_approval) {
      return `${element.approval_reason || `Activate “${element.accessible_name || "this control"}”`} on ${host}`;
    }
    if (APPROVAL_WORDS.test(element.accessible_name)) {
      return `Click “${element.accessible_name || "this control"}” on ${host}`;
    }
  }

  if (tool === "press_key" && String(input.key || "").toLowerCase() === "enter") {
    if (!element) {
      return `Press Enter on ${host}; this may submit the active form`;
    }
    if (element.enter_requires_approval) {
      return `Press Enter in “${element.accessible_name || element.role}” on ${host}; this may submit a non-GET form`;
    }
  }

  return null;
}

/** The approval question for an action under the person's approval mode. */
export function approvalQuestionFor(
  mode: ApprovalMode,
  observation: PageObservation,
  tool: ToolName,
  input: Record<string, unknown>
) {
  return approvalFor(mode, riskyActionQuestion(observation, tool, input), observation, tool, input);
}

export interface AgentTaskHooks {
  addActivity(text: string, state?: "working" | "done" | "error"): string;
  finishActivity(id: string, state?: "working" | "done" | "error"): void;
  isCancelled(): boolean;
  isPaused(): boolean;
  approvalQuestion: BrowserEngineDependencies["approvalDescription"];
  requestApproval: BrowserEngineDependencies["requestApproval"];
  requestUserAction: BrowserEngineDependencies["requestUserAction"];
}

export interface AgentTaskOptions {
  agentPrimary: ProviderConnection;
  agentFallback: ProviderConnection | null;
  session: { id: string; title: string };
  signal: AbortSignal;
  hooks: AgentTaskHooks;
  /**
   * The Space this task belongs to, fixed when it starts. The task, its
   * helpers and everything they remember stay in it, even if the person
   * switches Space while it runs.
   */
  spaceId: string;
  /**
   * The memory this task reads, fixed when it starts: the same source its
   * context was compiled from. The task and every helper recall past tasks
   * through it, never through another store behind its back.
   */
  memorySource: MemorySource;
  /**
   * Where the task's own memory is written (what it saw and did), fixed when
   * it starts, like the source. Helpers' findings reach memory only through
   * the parent task's record, so they use it too.
   */
  memoryWriter: MemoryWriter;
  /**
   * Extra guidance for the model only (About me, a matching Skill). It is
   * not part of the task, so memory, history and learned Skills stay clean.
   */
  context?: string;
}

export async function runAgentTask(
  task: string,
  { agentPrimary, agentFallback, session, spaceId, memorySource, memoryWriter, signal, hooks, context = "" }: AgentTaskOptions
): Promise<BrowserEngineResult> {
  let usedFallback = false;
  // Helpers run side by side, but the person answers one approval at a time.
  let approvalQueue: Promise<unknown> = Promise.resolve();
  const oneApprovalAtATime = (ask: () => Promise<boolean>): Promise<boolean> => {
    const answer = approvalQueue.then(ask, ask);
    approvalQueue = answer.catch(() => undefined);
    return answer;
  };
  const result = await runBrowserTask(
    task,
    {
      session: {
        id: session.id,
        title: session.title
      },
      decide: async ({
        task: browserTask,
        observation,
        trail,
        evidence,
        recalled_memory,
        recalled_procedures,
        mcp_catalog,
        screenshotDataUrl,
        signal
      }) => {
        const routed = await agentDecisionWithFallback(
          agentPrimary,
          agentFallback,
          browserTask + context,
          observation,
          trail,
          signal,
          evidence,
          screenshotDataUrl,
          recalled_memory,
          recalled_procedures,
          mcp_catalog
        );
        return {
          decision: routed.result,
          usedFallback: routed.usedFallback
        };
      },
      tool: async <T = unknown>(
        tool: ToolName,
        input: Record<string, unknown> = {},
        execution?: BrowserToolExecution
      ): Promise<ToolResult<T>> => {
        if (tool === "agent") {
          const launchWorker = async (spec: { task: string; max_steps: number; act?: boolean }, index: number) => {
                const workerTask = spec.task;
                const mode = spec.act ? "act" : "read";
                const name = spec.act ? `Helper ${index + 1}` : `Worker ${index + 1}`;
                const workerSessionId =
                  `${session.id}:worker:${index + 1}:${crypto.randomUUID()}`;
                const workerSessionTitle =
                  workerTask.length > 48
                    ? `${name}: ${workerTask.slice(0, 37)}…`
                    : `${name}: ${workerTask}`;
                const started = spec.act ? hooks.addActivity(`${name} started: ${workerTask.slice(0, 80)}`) : "";

                return runReadOnlySubagent(
                  workerTask,
                  {
                    session: {
                      id: workerSessionId,
                      title: workerSessionTitle
                    },
                    decide: async ({
                      task: subtask,
                      observation,
                      trail,
                      evidence,
                      mcp_catalog,
                      signal: workerSignal
                    }) => {
                      const routed =
                        await readOnlyWorkerDecisionWithFallback(
                          agentPrimary,
                          agentFallback,
                          subtask,
                          observation,
                          trail,
                          workerSignal,
                          evidence,
                          mcp_catalog,
                          mode
                        );
                      return {
                        decision: routed.result,
                        usedFallback:
                          routed.usedFallback
                      };
                    },
                    baseTool: (
                      workerTool,
                      workerInput = {},
                      workerExecution
                    ) =>
                      extensionMessage({
                        type: "BROWSER_TOOL",
                        tool: workerTool,
                        input: workerInput,
                        session_id:
                          workerSessionId,
                        session_title:
                          workerSessionTitle,
                        space_id: spaceId,
                        approval_granted: workerExecution?.approvalGranted
                      }),
                    mode,
                    approvalDescription: hooks.approvalQuestion,
                    // One question at a time, saying which helper asks.
                    requestApproval: (description) =>
                      oneApprovalAtATime(() =>
                        hooks.isCancelled()
                          ? Promise.resolve(false)
                          : hooks.requestApproval(`${name} (${workerTask.slice(0, 60)}): ${description}`)
                      ),
                    withActivity: spec.act
                      ? async (label, operation) => {
                          const id = hooks.addActivity(`${name}: ${label}`);
                          try {
                            const value = await operation();
                            hooks.finishActivity(id);
                            return value;
                          } catch (error) {
                            hooks.finishActivity(id, hooks.isCancelled() ? "done" : "error");
                            throw error;
                          }
                        }
                      : undefined,
                    recallMemory: async (
                      subtask,
                      observation
                    ) =>
                      // Helpers recall from the parent task's Space only, through the same memory source.
                      (await memorySource.relevantEpisodes(`${subtask} ${safeHostname(observation.url)}`, spaceId, 3)).episodes,
                    recallProcedures: (
                      subtask,
                      observation
                    ) =>
                      searchProceduralMemory(
                        `${subtask} ${safeHostname(observation.url)}`,
                        3
                      ),
                    discoverMcpCatalog: (
                      subtask,
                      observation
                    ) =>
                      buildMcpCatalog(
                        `${subtask} ${safeHostname(observation.url)}`,
                        (mcpInput) =>
                          extensionMessage({
                            type: "BROWSER_TOOL",
                            tool: "mcp",
                            input: mcpInput
                          }),
                        getMcpServerTrustMode
                      ),
                    isCancelled: () =>
                      hooks.isCancelled(),
                    waitWhilePaused: async () => {
                      while (
                        hooks.isPaused() &&
                        !hooks.isCancelled()
                      ) {
                        await new Promise(
                          (resolve) =>
                            window.setTimeout(
                              resolve,
                              150
                            )
                        );
                      }
                    },
                    onFallback: () => {
                      hooks.addActivity(
                        `Worker ${index + 1} used fallback model`,
                        "done"
                      );
                    }
                  },
                  signal,
                  spec.max_steps
                ).then(
                  (finding) => {
                    if (started) hooks.finishActivity(started, finding.status === "completed" ? "done" : "error");
                    return finding;
                  },
                  (error) => {
                    if (started) hooks.finishActivity(started, hooks.isCancelled() ? "done" : "error");
                    throw error;
                  }
                );
              };

          if (Array.isArray(input.dag)) {
            const dag = parseTaskDag(input.dag);
            if (!dag.ok) {
              return {
                ok: false,
                error: dag.error
              } as ToolResult<T>;
            }
            const outcome = await runTaskDag(
              dag.nodes,
              ({ node, prerequisites }, ) =>
                launchWorker(
                  {
                    task: buildDagWorkerTask(
                      node,
                      prerequisites
                    ),
                    max_steps: node.step_budget
                  },
                  dag.nodes.findIndex(
                    (item) => item.id === node.id
                  )
                ),
              signal
            );
            return {
              ok: true,
              data: outcome as T
            };
          }

          const parsed =
            parseReadOnlySubagentTasks(input);
          if (!parsed.ok) {
            return {
              ok: false,
              error: parsed.error
            } as ToolResult<T>;
          }

          const batch =
            await runReadOnlySubagentBatch(
              parsed.tasks,
              launchWorker,
              signal
            );

          return {
            ok: true,
            data: batch as T
          };
        }

        return extensionMessage<T>({
          type: "BROWSER_TOOL",
          tool,
          input,
          session_id: session.id,
          session_title: session.title,
          space_id: spaceId,
          approval_granted: execution?.approvalGranted
        });
      },
      approvalDescription: hooks.approvalQuestion,
      requestApproval: hooks.requestApproval,
      persistWorkingMemory: (memory) =>
        saveBrowserWorkingMemory(memory),
      recallMemory: async (
        browserTask,
        observation
      ) =>
        (await memorySource.relevantEpisodes(`${browserTask} ${safeHostname(observation.url)}`, spaceId, 3)).episodes,
      recallProcedures: (
        browserTask,
        observation
      ) =>
        searchProceduralMemory(
          `${browserTask} ${safeHostname(observation.url)}`,
          3
        ),
      discoverMcpCatalog: (
        browserTask,
        observation
      ) =>
        buildMcpCatalog(
          `${browserTask} ${safeHostname(observation.url)}`,
          (input) =>
            extensionMessage({
              type: "BROWSER_TOOL",
              tool: "mcp",
              input
            }),
          getMcpServerTrustMode
        ),
      requestUserAction: hooks.requestUserAction,
      isCancelled: () => hooks.isCancelled(),
      waitWhilePaused: async () => {
        while (hooks.isPaused() && !hooks.isCancelled()) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, 150)
          );
        }
      },
      withActivity: async (label, operation) => {
        const id = hooks.addActivity(label);
        try {
          const value = await operation();
          hooks.finishActivity(id);
          return value;
        } catch (error) {
          hooks.finishActivity(
            id,
            hooks.isCancelled() ? "done" : "error"
          );
          throw error;
        }
      },
      onFallback: () => {
        usedFallback = true;
        hooks.addActivity(
          "Primary unavailable — used fallback model",
          "done"
        );
      }
    },
    signal
  );

  // Kept as what the task observed, never as facts about the person.
  await memoryWriter
    .recordTaskEpisode(result.session_evidence, spaceId)
    .then(() => clearBrowserWorkingMemory(session.id))
    .catch(() => undefined);
  // Real evidence for the model menu's "Browser-ready" label.
  if (
    result.status === "completed" &&
    !usedFallback &&
    result.session_evidence.actions.length > 0 &&
    agentPrimary.agentHealth.status !== "healthy"
  ) {
    await markBrowserReady(agentPrimary.id).catch(() => undefined);
  }
  return result;
}
