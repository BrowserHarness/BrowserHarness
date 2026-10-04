import {
  runBrowserTask,
  type BrowserDecisionContext,
  type BrowserDecisionResult,
  type BrowserEngineDependencies,
  type BrowserToolExecution
} from "./browser-engine";
import type {
  ToolName,
  ToolResult
} from "./protocol";
import type {
  BrowserTaskSessionIdentity
} from "./session-evidence";
import type {
  TaskEpisodeMemory
} from "./task-memory";
import type {
  ProceduralSearchHit
} from "./procedural-memory";
import type {
  BrowserHarnessMcpCatalog
} from "./mcp-catalog";
import {
  newReadOnlyWorkerToolState,
  runReadOnlyWorkerTool
} from "./subagent-policy";

const DEFAULT_MAX_STEPS = 8;
const MAX_SOURCES = 6;
const MAX_TOOLS = 20;

export interface ReadOnlySubagentDependencies {
  session: BrowserTaskSessionIdentity;
  decide(
    context: BrowserDecisionContext
  ): Promise<BrowserDecisionResult>;
  baseTool<T = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>,
    execution?: BrowserToolExecution
  ): Promise<ToolResult<T>>;
  recallMemory?(
    task: string,
    observation: BrowserDecisionContext["observation"]
  ): Promise<TaskEpisodeMemory[]>;
  recallProcedures?(
    task: string,
    observation: BrowserDecisionContext["observation"]
  ): Promise<ProceduralSearchHit[]>;
  discoverMcpCatalog?(
    task: string,
    observation: BrowserDecisionContext["observation"]
  ): Promise<BrowserHarnessMcpCatalog>;
  isCancelled(): boolean;
  waitWhilePaused(): Promise<void>;
  withActivity?<T>(
    label: string,
    operation: () => Promise<T>
  ): Promise<T>;
  onFallback?(): void;
}

export interface ReadOnlySubagentFinding {
  status:
    | "completed"
    | "stopped"
    | "approval-cancelled"
    | "failed";
  message: string;
  steps: number;
  session_id: string;
  sources: Array<{
    url: string;
    title: string;
  }>;
  tools_used: string[];
}

function boundedSources(
  evidence: Array<{
    url: string;
    title: string;
  }>
): Array<{
  url: string;
  title: string;
}> {
  const unique = new Map<string, string>();
  for (const item of evidence) {
    if (!item.url || unique.has(item.url)) continue;
    unique.set(item.url, item.title);
    if (unique.size >= MAX_SOURCES) break;
  }
  return [...unique.entries()].map(([url, title]) => ({
    url,
    title
  }));
}

export async function runReadOnlySubagent(
  task: string,
  dependencies: ReadOnlySubagentDependencies,
  signal?: AbortSignal,
  maxSteps = DEFAULT_MAX_STEPS
): Promise<ReadOnlySubagentFinding> {
  const workerState = newReadOnlyWorkerToolState();
  const steps = Math.min(
    Math.max(Math.round(Number(maxSteps) || DEFAULT_MAX_STEPS), 1),
    DEFAULT_MAX_STEPS
  );

  const engineDependencies: BrowserEngineDependencies = {
    session: dependencies.session,
    decide: dependencies.decide,
    tool: (tool, input = {}, execution) =>
      runReadOnlyWorkerTool(
        tool,
        input,
        execution,
        workerState,
        dependencies.baseTool
      ),
    approvalDescription: () => null,
    requestApproval: async () => false,
    recallMemory: dependencies.recallMemory,
    recallProcedures: dependencies.recallProcedures,
    discoverMcpCatalog:
      dependencies.discoverMcpCatalog,
    isCancelled: dependencies.isCancelled,
    waitWhilePaused: dependencies.waitWhilePaused,
    withActivity:
      dependencies.withActivity ||
      (async (_label, operation) => operation()),
    onFallback: dependencies.onFallback
  };

  try {
    const result = await runBrowserTask(
      task,
      engineDependencies,
      signal,
      steps
    );

    return {
      status: result.status,
      message: result.message,
      steps: result.steps,
      session_id: dependencies.session.id,
      sources: boundedSources(result.evidence),
      tools_used: [
        ...new Set(
          result.session_evidence.actions.map(
            (action) => action.tool
          )
        )
      ].slice(0, MAX_TOOLS)
    };
  } catch (error) {
    if (signal?.aborted) throw error;

    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Read-only worker failed.",
      steps: 0,
      session_id: dependencies.session.id,
      sources: [],
      tools_used: []
    };
  } finally {
    await dependencies
      .baseTool("close_session", {})
      .catch(() => undefined);
  }
}
