import { changesPage, observationInputAfter } from "./post-action";
import type {
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";
import type { AgentDecision } from "./model-client";
import type { TaskEpisodeMemory } from "./task-memory";
import type { ProceduralSearchHit } from "./procedural-memory";
import type { BrowserHarnessMcpCatalog } from "./mcp-catalog";
import {
  MAX_TASK_ACTIONS,
  createLoopGuard,
  pageKeyFor,
  registerDecision
} from "./loop-guard";
import { clip, unreadablePageObservation } from "./prompt-budget";
import {
  TabEvidenceStore,
  type TabEvidence
} from "./tab-evidence";
import {
  buildBrowserWorkingMemory,
  type BrowserWorkingMemory
} from "./working-memory";
import {
  copySessionInput,
  pageContext,
  targetEvidence,
  type BrowserSessionActionEvidence,
  type BrowserSessionDelegationEvidence,
  type BrowserSessionManualHandoffEvidence,
  type BrowserTaskSessionEvidence,
  type BrowserTaskSessionIdentity
} from "./session-evidence";

export interface BrowserDecisionContext {
  task: string;
  observation: PageObservation;
  trail: string[];
  evidence: TabEvidence[];
  recalled_memory: TaskEpisodeMemory[];
  recalled_procedures: ProceduralSearchHit[];
  mcp_catalog: BrowserHarnessMcpCatalog;
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
  persistWorkingMemory?(
    memory: BrowserWorkingMemory
  ): Promise<void>;
  recallMemory?(
    task: string,
    observation: PageObservation
  ): Promise<TaskEpisodeMemory[]>;
  recallProcedures?(
    task: string,
    observation: PageObservation
  ): Promise<ProceduralSearchHit[]>;
  discoverMcpCatalog?(
    task: string,
    observation: PageObservation
  ): Promise<BrowserHarnessMcpCatalog>;
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

  if (tool === "site_commands") {
    if (input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)) {
      copied.parameters = Object.fromEntries(
        Object.keys(input.parameters as Record<string, unknown>).map((name) => [name, "<redacted>"])
      );
    }
    if (typeof input.args === "string") copied.args = "<redacted>";
  }

  if (
    tool === "mcp" &&
    input.action === "call_tool" &&
    input.arguments &&
    typeof input.arguments === "object" &&
    !Array.isArray(input.arguments)
  ) {
    copied.arguments = Object.fromEntries(
      Object.keys(
        input.arguments as Record<string, unknown>
      ).map((name) => [name, "<redacted>"])
    );
  }

  return copied;
}

function requiresPostActionVerification(
  tool: ToolName,
  input: Record<string, unknown>
): boolean {
  return changesPage(tool, input);
}

function tabIdFromResult(result: ToolResult): number | undefined {
  const data = result.data;
  if (!data || typeof data !== "object") return undefined;
  const tabId = (data as { tab_id?: unknown }).tab_id;
  return typeof tabId === "number" ? tabId : undefined;
}

function delegationEvidenceFromResult(
  tool: ToolName,
  result: ToolResult
): BrowserSessionDelegationEvidence | undefined {
  if (
    tool !== "agent" ||
    !result.ok ||
    !result.data ||
    typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    return undefined;
  }

  const data = result.data as {
    worker_count?: unknown;
    completed_count?: unknown;
    non_completed_count?: unknown;
    workers?: unknown;
  };
  if (!Array.isArray(data.workers)) return undefined;

  const workers = data.workers
    .slice(0, 2)
    .map((raw, fallbackIndex) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw)
      ) {
        return null;
      }
      const worker = raw as {
        index?: unknown;
        task?: unknown;
        finding?: unknown;
      };
      if (
        typeof worker.task !== "string" ||
        !worker.finding ||
        typeof worker.finding !== "object" ||
        Array.isArray(worker.finding)
      ) {
        return null;
      }

      const finding = worker.finding as {
        status?: unknown;
        session_id?: unknown;
        sources?: unknown;
        tools_used?: unknown;
      };
      const status =
        finding.status === "completed" ||
        finding.status === "stopped" ||
        finding.status === "approval-cancelled" ||
        finding.status === "failed"
          ? finding.status
          : "failed";

      const sources = Array.isArray(finding.sources)
        ? finding.sources
            .slice(0, 6)
            .flatMap((source) => {
              if (
                !source ||
                typeof source !== "object" ||
                Array.isArray(source)
              ) {
                return [];
              }
              const item = source as {
                url?: unknown;
                title?: unknown;
              };
              return typeof item.url === "string"
                ? [
                    {
                      url: item.url,
                      title:
                        typeof item.title === "string"
                          ? item.title
                          : ""
                    }
                  ]
                : [];
            })
        : [];

      const toolsUsed = Array.isArray(
        finding.tools_used
      )
        ? finding.tools_used
            .filter(
              (item): item is string =>
                typeof item === "string"
            )
            .slice(0, 20)
        : [];

      return {
        index:
          typeof worker.index === "number"
            ? worker.index
            : fallbackIndex,
        task: worker.task.slice(0, 1000),
        session_id:
          typeof finding.session_id === "string"
            ? finding.session_id
            : "",
        status,
        sources,
        tools_used: toolsUsed
      };
    })
    .filter(
      (
        worker
      ): worker is BrowserSessionDelegationEvidence["workers"][number] =>
        Boolean(worker)
    );

  return {
    worker_count:
      typeof data.worker_count === "number"
        ? data.worker_count
        : workers.length,
    completed_count:
      typeof data.completed_count === "number"
        ? data.completed_count
        : workers.filter(
            (worker) => worker.status === "completed"
          ).length,
    non_completed_count:
      typeof data.non_completed_count === "number"
        ? data.non_completed_count
        : workers.filter(
            (worker) => worker.status !== "completed"
          ).length,
    workers
  };
}

function observationInputFor(
  decision: Extract<AgentDecision, { kind: "tool" }>,
  result: ToolResult
): Record<string, unknown> {
  return observationInputAfter(decision.input, result);
}

export async function runBrowserTask(
  task: string,
  dependencies: BrowserEngineDependencies,
  signal?: AbortSignal,
  maxSteps = MAX_TASK_ACTIONS
): Promise<BrowserEngineResult> {
  const trail: string[] = [];
  const evidenceStore = new TabEvidenceStore();
  const loopGuard = createLoopGuard();

  const initial = await dependencies.withActivity(
    "Reading the current page",
    () =>
      dependencies.tool<PageObservation>("observe_page", {})
  );

  if (
    (!initial.ok || !initial.data) &&
    initial.error?.code !== "UNSUPPORTED_PAGE"
  ) {
    throw new Error(
      initial.error?.message || "Could not observe this page"
    );
  }

  // Starting on the New Tab page or another protected page is fine: the
  // model can still navigate or open a tab from there.
  let observation =
    initial.ok && initial.data
      ? initial.data
      : unreadablePageObservation(
          initial.error?.message || "This page cannot be read."
        );
  let screenshotDataUrl: string | undefined;
  evidenceStore.record(observation);

  const recalledMemory = dependencies.recallMemory
    ? await dependencies
        .recallMemory(task, observation)
        .catch(() => [])
    : [];
  const recalledProcedures = dependencies.recallProcedures
    ? await dependencies
        .recallProcedures(task, observation)
        .catch(() => [])
    : [];
  const mcpCatalog = dependencies.discoverMcpCatalog
    ? await dependencies
        .discoverMcpCatalog(task, observation)
        .catch(() => ({
          servers_considered: 0,
          tools: []
        }))
    : {
        servers_considered: 0,
        tools: []
      };

  const sessionIdentity = dependencies.session || {
    id: "browser-task",
    title: task.length > 48 ? `${task.slice(0, 45)}…` : task
  };
  const sessionStartedAt = new Date().toISOString();
  const sessionStart = pageContext(observation);
  const sessionActions: BrowserSessionActionEvidence[] = [];
  const manualHandoffs: BrowserSessionManualHandoffEvidence[] = [];

  const persistWorkingMemory = async () => {
    if (!dependencies.persistWorkingMemory) return;
    await dependencies
      .persistWorkingMemory(
        buildBrowserWorkingMemory({
          session_id: sessionIdentity.id,
          title: sessionIdentity.title,
          task,
          started_at: sessionStartedAt,
          current: pageContext(observation),
          actions: sessionActions,
          manual_handoffs: manualHandoffs
        })
      )
      .catch(() => undefined);
  };

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

  await persistWorkingMemory();

  let consecutiveFailures = 0;
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
          recalled_memory: recalledMemory,
          recalled_procedures: recalledProcedures,
          mcp_catalog: mcpCatalog,
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

    const loopCheck = registerDecision(
      loopGuard,
      decision,
      pageKeyFor(observation)
    );
    if (!loopCheck.ok) {
      return buildResult(
        "stopped",
        `${loopCheck.reason} ${progressSummary(observation, sessionActions.length)}`,
        step
      );
    }

    const beforeObservation = observation;

    if (decision.tool === "await_user_action") {
      const reason =
        typeof decision.input.reason === "string" &&
        decision.input.reason.trim()
          ? decision.input.reason.trim()
          : "A manual step is required on this page before BrowserHarness can continue.";

      if (!dependencies.requestUserAction) {
        throw new Error(
          "USER_ACTION_HANDOFF_UNAVAILABLE: the current BrowserHarness surface cannot request a manual step"
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
        await persistWorkingMemory();
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
      await persistWorkingMemory();
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
      await persistWorkingMemory();
      continue;
    }

    trail.push(
      clip(`${decision.tool}: ${JSON.stringify(result)}`, TRAIL_ENTRY_MAX)
    );

    // A failed action is evidence for the next decision, not the end of the
    // task: small models often send one bad argument and then recover.
    const failed = !result.ok;
    const stale = failed && result.error?.code === "ELEMENT_NOT_FOUND";
    consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
    if (failed && FATAL_TOOL_ERRORS.has(String(result.error?.code))) {
      throw new Error(
        result.error?.message || `Browser tool ${decision.tool} failed`
      );
    }
    if (failed && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return buildResult(
        "stopped",
        `I stopped after ${MAX_CONSECUTIVE_FAILURES} failed actions in a row. Last error: ${result.error?.message || `${decision.tool} failed`}`,
        step + 1
      );
    }
    if (failed && !stale) {
      trail.push(
        `${decision.tool} failed: ${result.error?.message || "unknown error"}. Choose a different action.`
      );
    }

    let verifiedContext:
      | ReturnType<typeof pageContext>
      | undefined;

    if (
      failed ||
      requiresPostActionVerification(
        decision.tool,
        decision.input
      )
    ) {
      if (!failed) {
        await dependencies.tool("wait", { milliseconds: 450 });
      }

      const verified = await dependencies.tool<PageObservation>(
        "observe_page",
        observationInputFor(decision, result)
      );

      if (
        (!verified.ok || !verified.data) &&
        verified.error?.code !== "UNSUPPORTED_PAGE"
      ) {
        throw new Error(
          verified.error?.message ||
            "Could not verify the page after the action"
        );
      }

      observation =
        verified.ok && verified.data
          ? verified.data
          : unreadablePageObservation(
              verified.error?.message || "This page cannot be read."
            );
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
        ...(delegationEvidenceFromResult(
          decision.tool,
          result
        )
          ? {
              delegation: delegationEvidenceFromResult(
                decision.tool,
                result
              )
            }
          : {}),
        ...(verifiedContext ? { after: verifiedContext } : {})
      });
      await persistWorkingMemory();
    }
  }

  if (dependencies.isCancelled()) {
    return buildResult("stopped", "Stopped.", maxSteps);
  }

  return buildResult(
    "stopped",
    `I reached the limit of ${maxSteps} steps before finishing. ${progressSummary(observation, sessionActions.length)}`,
    maxSteps
  );
}

const TRAIL_ENTRY_MAX = 8000;
const MAX_CONSECUTIVE_FAILURES = 3;
// Policy refusals end the task at once instead of being retried.
const FATAL_TOOL_ERRORS = new Set([
  "SUBAGENT_SCOPE_DENIED",
  "PERMISSION_REQUIRED"
]);

function progressSummary(
  observation: PageObservation,
  actions: number
): string {
  return `${actions} action${actions === 1 ? "" : "s"} done; last page: ${observation.title || observation.url}.`;
}
