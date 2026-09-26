import type {
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";
import type { AgentDecision } from "./model-client";
import { createLoopGuard, registerDecision } from "./loop-guard";
import {
  TabEvidenceStore,
  type TabEvidence
} from "./tab-evidence";

export interface BrowserDecisionContext {
  task: string;
  observation: PageObservation;
  trail: string[];
  evidence: TabEvidence[];
  signal?: AbortSignal;
}

export interface BrowserDecisionResult {
  decision: AgentDecision;
  usedFallback?: boolean;
}

export interface BrowserEngineDependencies {
  decide(
    context: BrowserDecisionContext
  ): Promise<BrowserDecisionResult>;
  tool<T = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>
  ): Promise<ToolResult<T>>;
  approvalDescription(
    observation: PageObservation,
    tool: ToolName,
    input: Record<string, unknown>
  ): string | null;
  requestApproval(description: string): Promise<boolean>;
  isCancelled(): boolean;
  waitWhilePaused(): Promise<void>;
  withActivity<T>(
    label: string,
    operation: () => Promise<T>
  ): Promise<T>;
  onFallback?(): void;
}

export interface BrowserEngineResult {
  status: "completed" | "stopped" | "approval-cancelled";
  message: string;
  steps: number;
  evidence: TabEvidence[];
}

const MUTATING_OR_CONTEXT_CHANGING_TOOLS: ToolName[] = [
  "navigate",
  "click",
  "type",
  "press_key",
  "scroll",
  "open_tab",
  "switch_tab"
];

function tabIdFromResult(result: ToolResult): number | undefined {
  const data = result.data;
  if (!data || typeof data !== "object") return undefined;
  const tabId = (data as { tab_id?: unknown }).tab_id;
  return typeof tabId === "number" ? tabId : undefined;
}

function observationInputFor(
  decision: Extract<AgentDecision, { kind: "tool" }>,
  result: ToolResult
): Record<string, unknown> {
  const resultTabId = tabIdFromResult(result);
  if (resultTabId) return { tab_id: resultTabId };

  const requestedTabId = decision.input.tab_id;
  if (typeof requestedTabId === "number") {
    return { tab_id: requestedTabId };
  }

  return {};
}

export async function runBrowserTask(
  task: string,
  dependencies: BrowserEngineDependencies,
  signal?: AbortSignal,
  maxSteps = 12
): Promise<BrowserEngineResult> {
  const trail: string[] = [];
  const evidenceStore = new TabEvidenceStore();
  const loopGuard = createLoopGuard();

  const initial = await dependencies.withActivity(
    "Reading the current page",
    () =>
      dependencies.tool<PageObservation>("observe_page", {})
  );

  if (!initial.ok || !initial.data) {
    throw new Error(
      initial.error?.message || "Could not observe this page"
    );
  }

  let observation = initial.data;
  evidenceStore.record(observation);

  for (let step = 0; step < maxSteps; step += 1) {
    if (dependencies.isCancelled()) {
      return {
        status: "stopped",
        message: "Stopped.",
        steps: step,
        evidence: evidenceStore.list()
      };
    }

    await dependencies.waitWhilePaused();

    const routed = await dependencies.withActivity(
      "Deciding the next action",
      () =>
        dependencies.decide({
          task,
          observation,
          trail,
          evidence: evidenceStore.list(),
          signal
        })
    );

    if (routed.usedFallback) {
      dependencies.onFallback?.();
    }

    const decision = routed.decision;
    if (decision.kind === "final") {
      return {
        status: "completed",
        message: decision.message,
        steps: step,
        evidence: evidenceStore.list()
      };
    }

    const loopCheck = registerDecision(loopGuard, decision);
    if (!loopCheck.ok) {
      throw new Error(loopCheck.reason);
    }

    const approval = dependencies.approvalDescription(
      observation,
      decision.tool,
      decision.input
    );

    if (approval) {
      const approved = await dependencies.requestApproval(approval);
      if (!approved) {
        return {
          status: "approval-cancelled",
          message: "I stopped before that action.",
          steps: step,
          evidence: evidenceStore.list()
        };
      }
    }

    const result = await dependencies.withActivity(
      decision.note || `Using ${decision.tool}`,
      () => dependencies.tool(decision.tool, decision.input)
    );

    trail.push(
      `${decision.tool}: ${JSON.stringify(result)}`
    );

    const stale =
      !result.ok && result.error?.code === "ELEMENT_NOT_FOUND";

    if (!result.ok && !stale) {
      throw new Error(
        result.error?.message ||
          `Browser tool ${decision.tool} failed`
      );
    }

    if (
      stale ||
      MUTATING_OR_CONTEXT_CHANGING_TOOLS.includes(decision.tool)
    ) {
      if (!stale) {
        await dependencies.tool("wait", { milliseconds: 450 });
      }

      const verified = await dependencies.tool<PageObservation>(
        "observe_page",
        observationInputFor(decision, result)
      );

      if (!verified.ok || !verified.data) {
        throw new Error(
          verified.error?.message ||
            "Could not verify the page after the action"
        );
      }

      observation = verified.data;
      evidenceStore.record(observation);
      trail.push(
        `verification: adapter=${observation.adapter || "generic-web"} tab=${observation.tab_id} page=${observation.title} url=${observation.url}`
      );

      if (stale) {
        trail.push(
          "Element became stale; page was re-observed before retry."
        );
      }
    }
  }

  if (dependencies.isCancelled()) {
    return {
      status: "stopped",
      message: "Stopped.",
      steps: maxSteps,
      evidence: evidenceStore.list()
    };
  }

  throw new Error(
    "Task reached the bounded action limit before completion."
  );
}
