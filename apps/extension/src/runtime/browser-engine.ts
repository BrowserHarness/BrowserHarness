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
import {
  copySessionInput,
  pageContext,
  targetEvidence,
  type BrowserSessionActionEvidence,
  type BrowserSessionManualHandoffEvidence,
  type BrowserTaskSessionEvidence,
  type BrowserTaskSessionIdentity
} from "./session-evidence";

export interface BrowserDecisionContext {
  task: string;
  observation: PageObservation;
  trail: string[];
  evidence: TabEvidence[];
  screenshotDataUrl?: string;
  signal?: AbortSignal;
}

export interface BrowserDecisionResult {
  decision: AgentDecision;
  usedFallback?: boolean;
}

export interface BrowserToolExecution {
  approvalGranted?: boolean;
}

export interface BrowserUserActionOutcome {
  status: "continue" | "cancelled";
  source: "navigation" | "user";
}

export interface BrowserEngineDependencies {
  session?: BrowserTaskSessionIdentity;
  decide(
    context: BrowserDecisionContext
  ): Promise<BrowserDecisionResult>;
  tool<T = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>,
    execution?: BrowserToolExecution
  ): Promise<ToolResult<T>>;
  approvalDescription(
    observation: PageObservation,
    tool: ToolName,
    input: Record<string, unknown>
  ): string | null;
  requestApproval(description: string): Promise<boolean>;
  requestUserAction?(
    reason: string,
    observation: PageObservation,
    signal?: AbortSignal
  ): Promise<BrowserUserActionOutcome>;
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
  session_evidence: BrowserTaskSessionEvidence;
}

const MUTATING_OR_CONTEXT_CHANGING_TOOLS: ToolName[] = [
  "navigate",
  "click",
  "type",
  "press_key",
  "trusted_click",
  "trusted_type",
  "trusted_key",
  "send_keys",
  "select_option",
  "hover",
  "drag",
  "dialog",
  "evaluate",
  "cdp",
  "scroll",
  "open_tab",
  "find_tab",
  "switch_tab"
];

function sessionInputForTool(
  tool: ToolName,
  input: Record<string, unknown>
): Record<string, unknown> {
  const copied = copySessionInput(input);

  if (
    tool === "site_skill" &&
    input.action === "run" &&
    input.parameters &&
    typeof input.parameters === "object" &&
    !Array.isArray(input.parameters)
  ) {
    copied.parameters = Object.fromEntries(
      Object.keys(input.parameters as Record<string, unknown>).map(
        (name) => [name, "<redacted>"]
      )
    );
  }

  return copied;
}

function requiresPostActionVerification(
  tool: ToolName,
  input: Record<string, unknown>
): boolean {
  if (tool === "site_skill") return input.action === "run";
  return MUTATING_OR_CONTEXT_CHANGING_TOOLS.includes(tool);
}

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
  let screenshotDataUrl: string | undefined;
  evidenceStore.record(observation);

  const sessionIdentity = dependencies.session || {
    id: "browser-task",
    title: task.length > 48 ? `${task.slice(0, 45)}…` : task
  };
  const sessionStartedAt = new Date().toISOString();
  const sessionStart = pageContext(observation);
  const sessionActions: BrowserSessionActionEvidence[] = [];
  const manualHandoffs: BrowserSessionManualHandoffEvidence[] = [];

  const buildResult = (
    status: BrowserEngineResult["status"],
    message: string,
    steps: number
  ): BrowserEngineResult => {
    const evidence = evidenceStore.list();
    return {
      status,
      message,
      steps,
      evidence,
      session_evidence: {
        version: 1,
        session_id: sessionIdentity.id,
        title: sessionIdentity.title,
        task,
        started_at: sessionStartedAt,
        status,
        start: sessionStart,
        actions: sessionActions.map((action) => ({
          ...action,
          input: copySessionInput(action.input)
        })),
        ...(manualHandoffs.length
          ? {
              manual_handoffs: manualHandoffs.map((handoff) => ({
                ...handoff,
                before: { ...handoff.before },
                ...(handoff.after
                  ? { after: { ...handoff.after } }
                  : {})
              }))
            }
          : {}),
        ...(sessionActions.length
          ? {
              boundary_action_id:
                sessionActions[sessionActions.length - 1].id
            }
          : {}),
        tab_evidence: evidence
      }
    };
  };

  for (let step = 0; step < maxSteps; step += 1) {
    if (dependencies.isCancelled()) {
      return buildResult("stopped", "Stopped.", step);
    }

    await dependencies.waitWhilePaused();

    const screenshotForDecision = screenshotDataUrl;
    const routed = await dependencies.withActivity(
      "Deciding the next action",
      () =>
        dependencies.decide({
          task,
          observation,
          trail,
          evidence: evidenceStore.list(),
          screenshotDataUrl: screenshotForDecision,
          signal
        })
    );
    screenshotDataUrl = undefined;

    if (routed.usedFallback) {
      dependencies.onFallback?.();
    }

    const decision = routed.decision;
    if (decision.kind === "final") {
      return buildResult("completed", decision.message, step);
    }

    const loopCheck = registerDecision(loopGuard, decision);
    if (!loopCheck.ok) {
      throw new Error(loopCheck.reason);
    }

    const beforeObservation = observation;

    if (decision.tool === "await_user_action") {
      const reason =
        typeof decision.input.reason === "string" &&
        decision.input.reason.trim()
          ? decision.input.reason.trim()
          : "A manual step is required on this page before BrowserCrew can continue.";

      if (!dependencies.requestUserAction) {
        throw new Error(
          "USER_ACTION_HANDOFF_UNAVAILABLE: the current BrowserCrew surface cannot request a manual step"
        );
      }

      const outcome = await dependencies.withActivity(
        "Waiting for your manual step",
        () =>
          dependencies.requestUserAction!(
            reason,
            beforeObservation,
            signal
          )
      );

      if (outcome.status === "cancelled") {
        manualHandoffs.push({
          id: `handoff-${manualHandoffs.length + 1}`,
          recorded_at: new Date().toISOString(),
          reason,
          status: "cancelled",
          source: outcome.source,
          before: pageContext(beforeObservation)
        });
        trail.push(
          `await_user_action: cancelled — ${reason}`
        );
        return buildResult(
          "stopped",
          `I stopped because the manual step was cancelled: ${reason}`,
          step + 1
        );
      }

      const verified = await dependencies.tool<PageObservation>(
        "observe_page",
        { tab_id: beforeObservation.tab_id }
      );
      if (!verified.ok || !verified.data) {
        throw new Error(
          verified.error?.message ||
            "Could not re-read the page after the manual step"
        );
      }

      observation = verified.data;
      evidenceStore.record(observation);
      manualHandoffs.push({
        id: `handoff-${manualHandoffs.length + 1}`,
        recorded_at: new Date().toISOString(),
        reason,
        status: "continued",
        source: outcome.source,
        before: pageContext(beforeObservation),
        after: pageContext(observation)
      });
      trail.push(
        `await_user_action: continued via ${outcome.source}; page=${observation.title}`
      );
      continue;
    }

    let approval = dependencies.approvalDescription(
      beforeObservation,
      decision.tool,
      decision.input
    );
    let approvalGranted = false;

    if (approval) {
      const approved = await dependencies.requestApproval(approval);
      if (!approved) {
        return buildResult(
          "approval-cancelled",
          "I stopped before that action.",
          step
        );
      }
      approvalGranted = true;
    }

    let result = await dependencies.withActivity(
      decision.note || `Using ${decision.tool}`,
      () =>
        dependencies.tool(
          decision.tool,
          decision.input,
          approvalGranted ? { approvalGranted: true } : undefined
        )
    );

    if (
      !result.ok &&
      result.error?.code === "APPROVAL_REQUIRED" &&
      !approvalGranted
    ) {
      approval =
        result.error.message ||
        `Approve ${decision.tool} on this page`;
      const approved = await dependencies.requestApproval(approval);
      if (!approved) {
        return buildResult(
          "approval-cancelled",
          "I stopped before that action.",
          step
        );
      }

      approvalGranted = true;
      result = await dependencies.withActivity(
        `Approved: ${decision.note || decision.tool}`,
        () =>
          dependencies.tool(
            decision.tool,
            decision.input,
            { approvalGranted: true }
          )
      );
    }

    if (decision.tool === "screenshot" && result.ok) {
      sessionActions.push({
        id: `action-${sessionActions.length + 1}`,
        ordinal: sessionActions.length + 1,
        recorded_at: new Date().toISOString(),
        tool: decision.tool,
        input: sessionInputForTool(decision.tool, decision.input),
        note: decision.note,
        before: pageContext(beforeObservation),
        ...(targetEvidence(
          beforeObservation,
          decision.input.element_id
        )
          ? {
              target: targetEvidence(
                beforeObservation,
                decision.input.element_id
              )
            }
          : {}),
        approval: {
          required: Boolean(approval),
          approved: true,
          ...(approval ? { description: approval } : {})
        },
        ...(tabIdFromResult(result)
          ? { result_tab_id: tabIdFromResult(result) }
          : {})
      });

      const data =
        result.data && typeof result.data === "object"
          ? (result.data as { data_url?: unknown })
          : null;
      if (typeof data?.data_url !== "string") {
        throw new Error("Screenshot tool did not return image data.");
      }
      screenshotDataUrl = data.data_url;
      trail.push("screenshot: captured visual evidence");
      continue;
    }

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

    let verifiedContext:
      | ReturnType<typeof pageContext>
      | undefined;

    if (
      stale ||
      requiresPostActionVerification(
        decision.tool,
        decision.input
      )
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
      verifiedContext = pageContext(observation);
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

    if (result.ok) {
      const target = targetEvidence(
        beforeObservation,
        decision.input.element_id
      );
      const resultTabId = tabIdFromResult(result);
      sessionActions.push({
        id: `action-${sessionActions.length + 1}`,
        ordinal: sessionActions.length + 1,
        recorded_at: new Date().toISOString(),
        tool: decision.tool,
        input: sessionInputForTool(decision.tool, decision.input),
        note: decision.note,
        before: pageContext(beforeObservation),
        ...(target ? { target } : {}),
        approval: {
          required: Boolean(approval),
          approved: true,
          ...(approval ? { description: approval } : {})
        },
        ...(resultTabId ? { result_tab_id: resultTabId } : {}),
        ...(verifiedContext ? { after: verifiedContext } : {})
      });
    }
  }

  if (dependencies.isCancelled()) {
    return buildResult("stopped", "Stopped.", maxSteps);
  }

  throw new Error(
    "Task reached the bounded action limit before completion."
  );
}
