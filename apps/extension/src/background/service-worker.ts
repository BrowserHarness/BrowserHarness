import type { RecordedWorkflowStep } from "../runtime/workflows";
import {
  changesPage,
  observationInputAfter,
  settleMsAfter
} from "../runtime/post-action";
import type {
  ExtensionRequest,
  PageObservation,
  ToolName,
  ToolResult
} from "../runtime/protocol";
import { getAttachmentsByIds } from "../runtime/attachments";
import { loadSkills, skillTask } from "../runtime/skills";
import {
  describeSiteCommand,
  findSiteCommand,
  loadSiteCommands,
  parseCommandArgs,
  recipeParameters
} from "../runtime/site-commands";
import {
  ALARM_PREFIX,
  CHAT_APP_LABELS,
  SCHEDULES_STORAGE_KEY,
  describeSchedule,
  isChatApp,
  loadSchedules,
  markScheduleStarted,
  newScheduledTask,
  parseScheduleText,
  plannedAlarms,
  saveScheduledTask,
  setScheduleEnabled
} from "../runtime/schedules";
import {
  RUNNING_CHAT_TASKS_KEY,
  parseChatCommand,
  scheduleToTurnOff,
  schedulesText,
  statusText,
  type RunningChatTask
} from "../runtime/chat-commands";
import {
  QUICK_EXPLAIN_MENU_ID,
  QUICK_EXPLAIN_STORAGE_KEY,
  type PendingExplain
} from "../runtime/quick-explain";
import {
  requestBridgeChat,
  requestBridgeLlm,
  sendBridgeEvent,
  startBridgeClient,
  type BridgeCommand,
  requestBridgeApi
} from "./bridge-client";
import { originPatternForUrl } from "../settings/browser-access";
import { readPage } from "./read-page";
import { normalizeNavigableUrl } from "./url-normalize";
import {
  cdpCommand,
  getJavaScriptDialog,
  handleJavaScriptDialog
} from "./cdp-manager";
import {
  captureAxSnapshot,
  elementForAxRef,
  accessibleNameForRef,
  findAxElements
} from "./cdp-semantic";
import {
  parseTrustedKeySequence,
  trustedClick,
  trustedDrag,
  trustedHover,
  trustedInsertAtFocus,
  trustedKey,
  trustedSendKeys,
  trustedType
} from "./cdp-input";
import {
  savePageAsPdf,
  uploadAttachments,
  uploadFiles
} from "./file-tools";
import {
  listNetworkRecords,
  networkCaptureActive,
  networkRecordDetail,
  startNetworkCapture,
  stopNetworkCapture
} from "./network-capture";
import { shouldActivateNewTaskTab } from "./tab-policy";
import { captureCdpScreenshot } from "./cdp-screenshot";
import { selectOptions } from "./cdp-select";
import { evaluatePageExpression } from "./page-evaluate";
import { collectCurrentSiteSkill } from "../runtime/site-skill-collector";
import { collectApiCapture, waitForNetworkQuiet } from "./api-capture";
import { learnApiOperation, type ApiLearnInput } from "./api-learning";
import { runTier } from "./api-transports";
import {
  examplesFromSteps,
  forgetWatchCapture,
  keepWatchCapture,
  noteWatchStart,
  takeWatchStart,
  watchCapture,
  watchCaptureSummary
} from "./api-watch";
import { checkApiHealth, nextForClass, repairApiOperation, type RepairLedger } from "./api-repair";
import { dispatchApiOperation, rememberedTier, rememberTier } from "../runtime/api-dispatch";
import { apiRecipeNeedsApproval, type ApiCallResult, type ApiOperationContract } from "../runtime/api-recipe";
import { verifySiteSkillCandidate } from "../runtime/site-skill-verifier";
import {
  runSiteSkillRecipe,
  selectSiteSkillRecipe,
  SiteSkillRunError
} from "../runtime/site-skill-runner";
import {
  deleteSiteSkillCandidate,
  getSiteSkillCandidate,
  getSiteSkillExecutableRevision,
  getSiteSkillFamily,
  getSiteSkillPromotionGate,
  getSiteSkillRevisionComparison,
  getSiteSkillRevision,
  listSiteSkillCandidateSummaries,
  listSiteSkillRevisionSummaries,
  listSiteSkillExecutionEvidence,
  promoteSiteSkillRevision,
  recordSiteSkillEvaluation,
  recordSiteSkillExecutionEvidence,
  rollbackSiteSkillRevision,
  saveSiteSkillCandidate
} from "../runtime/site-skill-store";
import {
  createRefinedSiteSkillCandidate
} from "../runtime/site-skill-refinement";
import {
  deleteTaskEpisodeMemory,
  getTaskEpisodeMemory,
  listTaskEpisodeMemory
} from "../runtime/task-memory";
import {
  deleteTaskEpisodeVector,
  searchTaskMemoryHybrid
} from "../runtime/semantic-memory";
import {
  searchProceduralMemory
} from "../runtime/procedural-memory";
import {
  clearBrowserWorkingMemory,
  getBrowserWorkingMemory
} from "../runtime/working-memory";
import {
  extensionPageApprovalGranted,
  isRiskyTrustedLabel,
  type ToolExecutionOptions
} from "./approval-grant";
import { runExternalMcpTool } from "./mcp-tools";
import { enqueueRemoteTask } from "../runtime/remote-queue";
import {
  goBackAndWait,
  reloadAndWait,
  waitForTabUsable,
  type NavigationReadyResult
} from "./navigation";
import {
  appendWatchStep,
  getWatchRecording,
  startWatchRecording,
  stopWatchRecording,
  watchRecordingSummary
} from "./watch-recording";
import { createWatchBrowserEventHandlers } from "./watch-browser-events";
import {
  borrowTab,
  closeTaskSession,
  ensureTaskSession,
  getTaskSession,
  ownTab,
  removeSessionTab,
  selectSessionTab,
  setSessionGroup,
  type TaskSession
} from "./task-sessions";

chrome.runtime.onInstalled.addListener((details) => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
  // First install: open the welcome page, which walks through connecting an AI.
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#home") }).catch(() => undefined);
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: QUICK_EXPLAIN_MENU_ID,
      title: "Explain selection with BrowserHarness",
      contexts: ["selection"]
    });
  });
});

// Scheduled tasks: one alarm per enabled schedule, kept in step with storage.
async function syncScheduleAlarms(): Promise<void> {
  const planned = plannedAlarms(await loadSchedules());
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (
      alarm.name.startsWith(ALARM_PREFIX) &&
      !planned.some((item) => `${ALARM_PREFIX}${item.id}` === alarm.name)
    ) {
      await chrome.alarms.clear(alarm.name);
    }
  }
  for (const item of planned) {
    const name = `${ALARM_PREFIX}${item.id}`;
    const current = existing.find((alarm) => alarm.name === name);
    if (!current || Math.abs(current.scheduledTime - item.when) > 1000) {
      await chrome.alarms.create(name, { when: item.when });
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncScheduleAlarms().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  void syncScheduleAlarms().catch(() => undefined);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SCHEDULES_STORAGE_KEY]) {
    void syncScheduleAlarms().catch(() => undefined);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length);
  void (async () => {
    const item = await markScheduleStarted(id);
    if (!item) return;
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`runner.html?schedule=${encodeURIComponent(id)}`),
      active: false
    });
  })().catch(() => undefined);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("browserharness-run:")) return;
  chrome.notifications.clear(notificationId);
  void chrome.tabs
    .create({ url: chrome.runtime.getURL("sidepanel.html?view=scheduled") })
    .catch(() => undefined);
});

async function skillsTool(input: Record<string, unknown>, spaceId?: string): Promise<ToolResult> {
  const skills = await loadSkills(spaceId);
  const name =
    typeof input.name === "string"
      ? input.name.trim().replace(/^\//, "").toLowerCase()
      : "";
  if (!name) {
    return {
      ok: true,
      data: {
        skills: skills.map((skill) => ({
          name: skill.slug,
          title: skill.name,
          description: skill.description,
          start_url: skill.start_url,
          runs: skill.runs,
          worked: skill.successes
        })),
        hint: skills.length
          ? "Call skills again with name to get one Skill's steps, then follow them with the browser tools."
          : "No Skills saved yet. The person saves them from the BrowserHarness side panel."
      }
    };
  }
  const skill =
    skills.find((item) => item.slug === name) ||
    skills.find((item) => item.name.toLowerCase() === name);
  if (!skill) {
    return {
      ok: false,
      error: {
        code: "SKILL_NOT_FOUND",
        message: `No Skill called ${name}. Call skills without a name to list them.`
      }
    };
  }
  return {
    ok: true,
    data: {
      name: skill.slug,
      title: skill.name,
      start_url: skill.start_url,
      instructions: skillTask(
        skill,
        typeof input.details === "string" ? input.details : ""
      )
    }
  };
}

function sameOrigin(url: string | undefined, origin: string): boolean {
  try {
    return Boolean(url) && new URL(url as string).origin === origin;
  } catch {
    return false;
  }
}

function samePage(url: string | undefined, target: string): boolean {
  try {
    const a = new URL(url as string);
    const b = new URL(target);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}

/**
 * Website → command. Without a name it lists the commands learned from Site
 * Skills; with one it opens the site in a task tab (unless the task is
 * already there) and runs that recipe through site_skill, so the usual
 * checks, approvals and run records apply.
 */
async function siteCommandsTool(
  input: Record<string, unknown>,
  sessionId: string | undefined,
  sessionTitle: string | undefined,
  options: ToolExecutionOptions
): Promise<ToolResult> {
  const commands = await loadSiteCommands();
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    return {
      ok: true,
      data: {
        commands: commands.map(describeSiteCommand),
        hint: commands.length
          ? "Run one with site_commands name and parameters. read commands only fetch the site's own data; form commands fill and send a form and may need the person's approval in Chrome."
          : "No site commands yet. They come from Site Skills: ask BrowserHarness to learn a website (site_skill create), then each of its forms and data requests becomes a command."
      }
    };
  }
  const command = findSiteCommand(commands, name);
  if (!command) {
    return {
      ok: false,
      error: {
        code: "SITE_COMMAND_NOT_FOUND",
        message: `No site command called ${name}. Call site_commands without a name to list them.`
      }
    };
  }
  const given =
    input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)
      ? (input.parameters as Record<string, unknown>)
      : typeof input.args === "string"
        ? parseCommandArgs(command, input.args)
        : {};
  const mapped = recipeParameters(command, given);
  if (!mapped.ok) {
    return { ok: false, error: { code: "SITE_COMMAND_PARAMETERS", message: mapped.error } };
  }

  const taskId = sessionId || `site-command-${command.name}`;
  const taskTitle = sessionTitle || command.title;
  const session = await requestSession(taskId, taskTitle);
  const current = session?.current_tab_id
    ? await chrome.tabs.get(session.current_tab_id).catch(() => null)
    : null;
  const ready =
    command.needs_page === false ||
    (command.kind === "read"
      ? sameOrigin(current?.url, command.origin)
      : samePage(current?.url, command.entry_url));
  if (!ready) {
    // Never repurpose the person's own tab: open the site in a task tab.
    const opened = await runTool("open_tab", { url: command.entry_url }, taskId, taskTitle);
    if (!opened.ok) return opened;
  }

  const result = await runTool(
    "site_skill",
    {
      action: "run",
      id: command.skill_id,
      revision_id: command.revision_id,
      recipe_id: command.recipe_id,
      parameters: mapped.parameters
    },
    taskId,
    taskTitle,
    options
  );
  if (!result.ok) return result;
  const run = (result.data as { run?: { submitted?: boolean; executed_steps?: number; output?: Record<string, unknown> } })?.run;
  return {
    ok: true,
    data: {
      command: command.name,
      site: command.site,
      kind: command.kind,
      ...(run?.output
        ? {
            http_status: run.output.http_status,
            truncated: run.output.truncated,
            output: run.output.data
          }
        : { submitted: Boolean(run?.submitted), steps: run?.executed_steps ?? 0 })
    }
  };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    info.menuItemId !== QUICK_EXPLAIN_MENU_ID ||
    !info.selectionText
  ) {
    return;
  }
  const pending: PendingExplain = {
    text: info.selectionText,
    url: info.pageUrl,
    created_at: Date.now()
  };
  // Open first: sidePanel.open needs the user gesture from this click.
  if (tab?.id !== undefined) {
    void chrome.sidePanel
      .open({ tabId: tab.id })
      .catch(() => undefined);
  }
  void chrome.storage.session.set({
    [QUICK_EXPLAIN_STORAGE_KEY]: pending
  });
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

/**
 * The tab a request is about. The full-page chat is a tab of its own, so when
 * it is in front, tasks work in the web page the person used last (or a new
 * tab), never in the chat itself.
 */
async function activeWebTab(openIfNone: boolean): Promise<chrome.tabs.Tab | null> {
  const tab = await activeTab();
  if (!tab.url?.startsWith(chrome.runtime.getURL(""))) return tab;
  const [recent] = (await chrome.tabs.query({ currentWindow: true }))
    .filter((item) => item.id !== tab.id && isInjectableUrl(item.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  if (recent?.id) return recent;
  return openIfNone ? chrome.tabs.create({ active: false }) : null;
}

/**
 * One run of a page for API learning in a background tab this task owns: the
 * capture starts before the page loads and the tab closes afterwards.
 */
async function runPageForApiLearning(url: string, session: TaskSession | null) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  if (!tab?.id) throw new Error("Chrome did not open a tab for the run");
  const tabId = tab.id;
  let owned = session;
  try {
    if (owned) {
      owned = await ownTab(owned, tabId);
      owned = await groupOwnedTab(owned, tabId);
    }
    await startNetworkCapture(tabId, 800);
    await chrome.tabs.update(tabId, { url });
    const ready = await waitForTabUsable(tabId);
    await waitForNetworkQuiet(tabId);
    return await collectApiCapture(tabId, ready.url || url, [url]);
  } finally {
    await stopNetworkCapture(tabId).catch(() => undefined);
    await chrome.tabs.remove(tabId).catch(() => undefined);
    if (owned) await removeSessionTab(owned, tabId).catch(() => undefined);
  }
}

async function learnApiTool(
  input: Record<string, unknown>,
  session: TaskSession | null
): Promise<ToolResult> {
  return learnApiOperation(apiLearnDeps(session), input as unknown as ApiLearnInput);
}

const API_REPAIR_KEY = "browserharness.apiRepair.v1";

function apiLearnDeps(session: TaskSession | null) {
  return {
    runPage: (url: string) => runPageForApiLearning(url, session),
    bridge: (action: "learn" | "verify", payload: Record<string, unknown>) => requestBridgeApi(action, payload, { timeoutMs: 120_000 }),
    // reads only: learn_api refuses writes before this point
    dispatch: (contract: ApiOperationContract, args: Record<string, unknown>) => callApiOperation(contract, args, false),
    loadBase: async (id: string) => {
      const revision = await getSiteSkillExecutableRevision(id);
      return revision ? { candidate: revision.candidate, revision_id: revision.revision_id } : null;
    },
    save: (candidate: import("../runtime/site-skill").SiteCandidateSkill, reason: "create" | "refinement") => saveSiteSkillCandidate(candidate, { reason }),
    evaluate: async (id: string, revisionId: string, entry: { kind: "structural-verification" | "execution"; outcome: "passed" | "failed"; detail: string }) => {
      await recordSiteSkillEvaluation(id, revisionId, entry);
    },
    execution: (id: string, revisionId: string, entry: Parameters<typeof recordSiteSkillExecutionEvidence>[2]) => recordSiteSkillExecutionEvidence(id, revisionId, entry),
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID().slice(0, 12),
    watchCapture: (id: string) => watchCapture(id),
    forgetWatch: (id: string) => forgetWatchCapture(id)
  };
}

/** Starts capturing the recorded tab's requests, for learning its API later. */
async function beginWatchApiCapture(recordingId: string, tabId: number): Promise<void> {
  const already = networkCaptureActive(tabId);
  if (!already) await startNetworkCapture(tabId, 2000).catch(() => undefined);
  if (networkCaptureActive(tabId)) noteWatchStart(recordingId, tabId, !already);
}

/** Keeps the recording's capture in memory, with what was typed, and says what it holds. */
async function finishWatchApiCapture(
  recordingId: string,
  startUrl: string,
  steps: import("../runtime/workflows").RecordedWorkflowStep[],
  events: import("../runtime/workflows").WorkflowRecordingEvent[]
) {
  const started = takeWatchStart(recordingId);
  if (!started || !networkCaptureActive(started.tab_id)) return undefined;
  try {
    await waitForNetworkQuiet(started.tab_id, 500, 3000);
    const tab = await chrome.tabs.get(started.tab_id).catch(() => null);
    const finalUrl = tab?.url || startUrl;
    const examples = examplesFromSteps(steps);
    const values = Object.values(examples).map((value) => value.toLowerCase());
    const visited = events
      .filter((event) => event.type === "navigation" && event.tab_id === started.tab_id)
      .map((event) => (event as { url: string }).url);
    // the page to replay is the one whose address carries what was typed, if any
    const located = [...visited, finalUrl].find((url) => {
      try {
        const decoded = decodeURIComponent(url).toLowerCase();
        return values.some((value) => decoded.includes(value));
      } catch {
        return false;
      }
    });
    const capture = await collectApiCapture(started.tab_id, finalUrl, [located || finalUrl]);
    return watchCaptureSummary(keepWatchCapture({ recording_id: recordingId, start_url: startUrl, capture, examples }));
  } catch {
    return undefined;
  } finally {
    if (started.started_capture) await stopNetworkCapture(started.tab_id).catch(() => undefined);
  }
}

function apiRecipesOf(candidate: import("../runtime/site-skill").SiteCandidateSkill, recipeId?: string) {
  return candidate.recipes
    .filter((recipe) => !recipeId || recipe.id === recipeId)
    .flatMap((recipe) => {
      const step = recipe.steps.find((item) => item.kind === "api_operation");
      return step && step.kind === "api_operation" ? [{ recipe, contract: step.contract }] : [];
    });
}

/** site_skill verify for a Skill made of learned operations: each read is called live with a taught input. */
async function apiHealthTool(
  id: string,
  revision: { revision_id: string; candidate: import("../runtime/site-skill").SiteCandidateSkill },
  recipeId?: string
): Promise<ToolResult> {
  const checks = [];
  for (const { recipe, contract } of apiRecipesOf(revision.candidate, recipeId)) {
    checks.push(await checkApiHealth((c, args) => callApiOperation(c, args, false), recipe.id, contract));
  }
  const ran = checks.filter((check) => check.class !== "skipped");
  const passed = ran.length > 0 && ran.every((check) => check.passed);
  await recordSiteSkillEvaluation(id, revision.revision_id, {
    kind: "structural-verification",
    outcome: passed ? "passed" : "failed",
    detail: `API health: ${checks.map((check) => `${check.recipe_id} ${check.passed ? "ok" : check.class}`).join("; ")}`.slice(0, 500)
  });
  const failing = ran.find((check) => !check.passed);
  return {
    ok: passed,
    data: {
      id,
      revision_id: revision.revision_id,
      health: checks,
      ...(failing ? { next_action: nextForClass(failing.class as ApiCallResult["class"], revision.candidate.site.origin) } : {})
    },
    ...(passed
      ? {}
      : {
          error: {
            code: "SITE_SKILL_VERIFICATION_FAILED",
            message: ran.length ? "A learned operation did not answer as it did when it was taught" : "No learned read could be checked"
          }
        })
  };
}

/** site_skill repair: learn a drifted read again as a new candidate revision; bounded per operation. */
async function repairApiTool(input: Record<string, unknown>, session: TaskSession | null): Promise<ToolResult> {
  if (typeof input.id !== "string" || !input.id.trim()) {
    return { ok: false, error: { code: "SITE_SKILL_ID_REQUIRED", message: "site_skill repair requires id" } };
  }
  const revision = await getSiteSkillExecutableRevision(input.id, typeof input.revision_id === "string" ? input.revision_id : undefined);
  if (!revision) return { ok: false, error: { code: "SITE_SKILL_NOT_FOUND", message: "Site Skill candidate was not found" } };
  const targets = apiRecipesOf(revision.candidate, typeof input.recipe_id === "string" ? input.recipe_id : undefined);
  if (targets.length !== 1) {
    return {
      ok: false,
      error: {
        code: targets.length ? "SITE_SKILL_RECIPE_REQUIRED" : "SITE_SKILL_RECIPE_NOT_FOUND",
        message: targets.length ? "Name the learned operation to repair with recipe_id" : "No learned API operation to repair; refine form recipes with site_skill refine"
      }
    };
  }
  const plain = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  return repairApiOperation(
    {
      learn: (learnInput) => learnApiOperation(apiLearnDeps(session), learnInput),
      ledger: async () => ((await chrome.storage.local.get(API_REPAIR_KEY))[API_REPAIR_KEY] || {}) as RepairLedger,
      saveLedger: (ledger) => chrome.storage.local.set({ [API_REPAIR_KEY]: ledger }),
      now: () => Date.now()
    },
    {
      skill_id: input.id,
      recipe_id: targets[0].recipe.id,
      contract: targets[0].contract,
      ...(Array.isArray(input.examples) ? { examples: input.examples.map(plain).filter((item): item is Record<string, unknown> => Boolean(item)) } : {}),
      ...(plain(input.verify_args) ? { verify_args: plain(input.verify_args) } : {}),
      ...(typeof input.page_url === "string" ? { page_url: input.page_url } : {})
    }
  );
}

/** Hybrid execution: the remembered tier first, then cheapest first; a write gets one attempt that reaches the site. */
function callApiOperation(
  contract: ApiOperationContract,
  args: Record<string, unknown>,
  approved: boolean
): Promise<ApiCallResult> {
  return dispatchApiOperation(
    { run: runTier, remembered: rememberedTier, remember: rememberTier },
    contract,
    args,
    { approved }
  );
}

/**
 * site_skill run for an API Recipe v2 recipe: no page or tab is needed. Reads
 * run without a prompt; anything else needs the person's approval first, and
 * one that may have run is never offered again.
 */
async function runApiOperationRecipe(
  input: Record<string, unknown>,
  revision: { revision_id: string; candidate: import("../runtime/site-skill").SiteCandidateSkill },
  recipeId: string,
  options: ToolExecutionOptions
): Promise<ToolResult> {
  const existing = revision.candidate;
  const id = String(input.id);
  const recipe = existing.recipes.find((item) => item.id === recipeId)!;
  const step = recipe.steps.find((item) => item.kind === "api_operation");
  if (apiRecipeNeedsApproval(recipe) && !options.approvalGranted) {
    return {
      ok: false,
      data: { revision_id: revision.revision_id },
      error: {
        code: "APPROVAL_REQUIRED",
        message: `Run Site Skill “${existing.name}” operation “${recipe.name}” on ${new URL(existing.site.origin).hostname}? It may change data there (${step && step.kind === "api_operation" ? step.contract.side_effect_basis : "not known to be read-only"}).`
      }
    };
  }
  const parameters =
    input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)
      ? (input.parameters as Record<string, unknown>)
      : {};
  const startedAt = new Date().toISOString();
  const evidenceId = existing.provenance.evidence_id;
  try {
    const run = await runSiteSkillRecipe({
      tab_id: -1,
      candidate: existing,
      recipe_id: recipe.id,
      parameters,
      api_call: (contract, args) => callApiOperation(contract, args, options.approvalGranted === true)
    });
    await recordSiteSkillEvaluation(id, revision.revision_id, {
      kind: "execution",
      outcome: "passed",
      detail: `API operation ${recipe.id} answered over tier ${run.output?.api?.tier ?? "?"} with ${run.output?.api?.item_count ?? 0} items`
    });
    const execution = await recordSiteSkillExecutionEvidence(id, revision.revision_id, {
      recipe_id: recipe.id,
      started_at: startedAt,
      outcome: "passed",
      evidence_id: evidenceId,
      executed_steps: run.executed_steps,
      submitted: run.submitted,
      parameter_names: Object.keys(parameters).sort()
    });
    return { ok: true, data: { candidate_id: existing.id, revision_id: revision.revision_id, run, execution } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Site Skill API operation failed";
    const code = error instanceof SiteSkillRunError && error.code ? error.code : "SITE_SKILL_RUN_FAILED";
    await recordSiteSkillEvaluation(id, revision.revision_id, { kind: "execution", outcome: "failed", detail: message }).catch(() => undefined);
    await recordSiteSkillExecutionEvidence(id, revision.revision_id, {
      recipe_id: recipe.id,
      started_at: startedAt,
      outcome: "failed",
      evidence_id: evidenceId,
      executed_steps: 0,
      submitted: error instanceof SiteSkillRunError ? error.submitted : false,
      parameter_names: Object.keys(parameters).sort(),
      error_code: code,
      error_message: message
    }).catch(() => null);
    const cls = code.startsWith("API_") ? (code.slice(4).toLowerCase() as ApiCallResult["class"]) : "network";
    return {
      ok: false,
      data: {
        candidate_id: existing.id,
        revision_id: revision.revision_id,
        failure_class: cls,
        repair_recommended: cls === "schema_drift" || cls === "endpoint_drift",
        next_action: nextForClass(cls, existing.site.origin) || "report the failure"
      },
      error: { code, message }
    };
  }
}

async function requestSession(
  sessionId?: string,
  sessionTitle?: string
): Promise<TaskSession | null> {
  if (!sessionId) return null;
  return ensureTaskSession(
    sessionId,
    sessionTitle?.trim() || "BrowserHarness task"
  );
}

async function targetTab(
  input: Record<string, unknown> = {},
  session: TaskSession | null = null
): Promise<{ tab: chrome.tabs.Tab; session: TaskSession | null }> {
  const requested = input.tab_id;

  if (typeof requested === "number") {
    if (session) {
      session = await selectSessionTab(session, requested);
    }
    const tab = await chrome.tabs.get(requested);
    if (!tab?.id) throw new Error("Tab not found");
    return { tab, session };
  }

  if (session?.current_tab_id) {
    const tab = await chrome.tabs
      .get(session.current_tab_id)
      .catch(() => null);
    if (tab?.id) return { tab, session };
    session = await removeSessionTab(
      session,
      session.current_tab_id
    );
  }

  const tab = (await activeWebTab(true))!;
  if (session && tab.id) {
    session = await borrowTab(session, tab.id);
  }
  return { tab, session };
}

async function groupOwnedTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  if (typeof session.group_id === "number") {
    try {
      await chrome.tabs.group({
        groupId: session.group_id,
        tabIds: [tabId]
      });
      return session;
    } catch {
      // Group may have been closed by the user; create a fresh one.
    }
  }

  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, {
    title: session.title.slice(0, 80),
    color: "blue",
    collapsed: false
  });
  return setSessionGroup(session, groupId);
}

function isInjectableUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Same id as content/adapters/google-docs.ts. Not imported: sharing a module
// with the content script would split content.js into chunks it cannot load.
const GOOGLE_DOCS_EDITOR_ID = "bc-google-doc-editor";

/**
 * Google Docs draws text on a canvas and only accepts real keyboard input in
 * a hidden editor frame. Focus that frame, then type through the debugger.
 */
async function googleDocsEditorAction(
  tabId: number,
  tool: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const focused = await sendToTab(tabId, {
    type: "EXECUTE_CONTENT_ACTION",
    action: "focus_editor",
    input: {}
  });
  if (!focused.ok) return focused;
  if (tool === "click" || tool === "trusted_click") {
    return {
      ok: true,
      data: {
        focused: GOOGLE_DOCS_EDITOR_ID,
        next: `The document is ready for text. Write it with type and element_id ${GOOGLE_DOCS_EDITOR_ID}.`
      }
    };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (!text) {
    return {
      ok: false,
      error: { code: "ELEMENT_NOT_FOUND", message: "type needs the text to write" }
    };
  }
  try {
    const typed = await trustedInsertAtFocus(tabId, text);
    return {
      ok: true,
      data: { ...typed, editor: "google-docs", mode: "keyboard" }
    };
  } catch (error) {
    // Debugger unavailable (for example DevTools is open on this tab):
    // fall back to the page-level text events.
    const fallback = await sendToTab(tabId, {
      type: "EXECUTE_CONTENT_ACTION",
      action: "type",
      input: { ...input, replace: false }
    });
    if (!fallback.ok) return fallback;
    // Google Docs ignores page-level events, so this cannot be reported as
    // typed: say so instead of letting the model claim success.
    return {
      ok: false,
      error: {
        code: "TRUSTED_TYPE_FAILED",
        message: `Could not type into Google Docs with real keyboard input (${error instanceof Error ? error.message : String(error)}). Close DevTools on this tab if it is open, then try again.`
      }
    };
  }
}

const PAGE_RESPONSE_TIMEOUT_MS = 20_000;

class PageTimeout extends Error {}

function sendWithTimeout(
  tabId: number,
  payload: unknown
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PageTimeout("page did not respond")),
      PAGE_RESPONSE_TIMEOUT_MS
    );
    chrome.tabs.sendMessage(tabId, payload).then(
      (value: ToolResult) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function sendToTab(
  tabId: number,
  payload: unknown
): Promise<ToolResult> {
  try {
    return await sendWithTimeout(tabId, payload);
  } catch (firstError) {
    if (firstError instanceof PageTimeout) {
      // Usually an alert/confirm/leave-page dialog blocking the page.
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_RESPONDING",
          message:
            "The page did not respond. It may be showing a dialog (alert, confirm or leave-page): use the dialog tool, or ask the user to close it."
        }
      };
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isInjectableUrl(tab.url)) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_PAGE",
          message:
            "BrowserHarness cannot control Chrome internal pages, the Chrome Web Store, or other protected browser pages."
        }
      };
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["assets/content.js"]
      });
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      const pattern = tab.url ? originPatternForUrl(tab.url) : null;
      const hasOriginPermission = pattern
        ? await chrome.permissions.contains({ origins: [pattern] })
        : false;

      if (!hasOriginPermission) {
        return {
          ok: false,
          error: {
            code: "PERMISSION_REQUIRED",
            message:
              "BrowserHarness needs website access for this tab. Grant all-sites access in Settings for cross-site and multi-tab automation.",
            details:
              error instanceof Error
                ? error.message
                : String(error)
          }
        };
      }

      return {
        ok: false,
        error: {
          code: "CONTENT_SCRIPT_UNAVAILABLE",
          message:
            "BrowserHarness could not attach to this page even though site access is granted. Reload this tab once and try again.",
          details:
            error instanceof Error
              ? error.message
              : String(error)
        }
      };
    }
  }
}

async function runTool(
  tool: string,
  input: Record<string, unknown> = {},
  sessionId?: string,
  sessionTitle?: string,
  options: ToolExecutionOptions = {}
): Promise<ToolResult> {
  let session = await requestSession(sessionId, sessionTitle);

  if (tool === "wait") {
    const milliseconds = Math.min(
      Math.max(Number(input.milliseconds ?? 500), 0),
      10_000
    );
    await new Promise((resolve) =>
      setTimeout(resolve, milliseconds)
    );
    return { ok: true, data: { milliseconds } };
  }

  if (tool === "mcp") {
    return runExternalMcpTool(input, options);
  }

  if (tool === "skills") {
    return skillsTool(input, options.spaceId);
  }

  if (tool === "site_commands") {
    return siteCommandsTool(input, sessionId, sessionTitle, options);
  }

  if (
    (tool === "navigate" || tool === "open_tab") &&
    typeof input.url === "string"
  ) {
    input = { ...input, url: normalizeNavigableUrl(input.url) };
  }

  if (tool === "open_tab") {
    const tab = await chrome.tabs.create({
      url: typeof input.url === "string" ? input.url : undefined,
      active: shouldActivateNewTaskTab(input)
    });
    if (!tab?.id) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "Chrome did not return the created tab"
        }
      };
    }

    if (session) {
      session = await ownTab(session, tab.id);
      session = await groupOwnedTab(session, tab.id);
    }

    let ready: NavigationReadyResult = {
      tab_id: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status
    };
    if (typeof input.url === "string") {
      try {
        ready = await waitForTabUsable(tab.id);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "NAVIGATION_TIMEOUT",
            message:
              error instanceof Error
                ? error.message
                : "New tab did not become usable"
          }
        };
      }
    }

    return {
      ok: true,
      data: {
        ...ready,
        session_id: session?.id,
        owned: Boolean(session)
      }
    };
  }

  if (tool === "list_tabs") {
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message: "list_tabs requires an active BrowserHarness task session"
        }
      };
    }

    const ids = [
      ...new Set([
        ...session.borrowed_tab_ids,
        ...session.owned_tab_ids
      ])
    ];
    const tabs = (
      await Promise.all(
        ids.map((id) => chrome.tabs.get(id).catch(() => null))
      )
    )
      .filter((tab): tab is chrome.tabs.Tab => Boolean(tab?.id))
      .map((tab) => ({
        tab_id: tab.id,
        url: tab.url,
        title: tab.title,
        active: Boolean(tab.active),
        owned: session!.owned_tab_ids.includes(tab.id!),
        borrowed: session!.borrowed_tab_ids.includes(tab.id!),
        group_id: tab.groupId
      }));

    return {
      ok: true,
      data: {
        session_id: session.id,
        title: session.title,
        current_tab_id: session.current_tab_id,
        tabs
      }
    };
  }

  if (tool === "find_tab") {
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message: "find_tab requires an active BrowserHarness task session"
        }
      };
    }

    if (input.active === true) {
      const tab = await activeTab();
      if (!tab.id) {
        return {
          ok: false,
          error: {
            code: "TAB_NOT_FOUND",
            message: "Chrome did not return the active tab"
          }
        };
      }
      session = await borrowTab(session, tab.id);
      return {
        ok: true,
        data: {
          tab_id: tab.id,
          url: tab.url,
          title: tab.title,
          borrowed: true
        }
      };
    }

    if (typeof input.url !== "string") {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "find_tab requires an exact url or active:true"
        }
      };
    }

    let requestedUrl = input.url;
    try {
      requestedUrl = new URL(input.url).href;
    } catch {
      // Keep the caller value for exact comparison/error reporting.
    }

    const ids = [
      ...new Set([
        ...session.borrowed_tab_ids,
        ...session.owned_tab_ids
      ])
    ];
    const candidates = await Promise.all(
      ids.map((id) => chrome.tabs.get(id).catch(() => null))
    );
    const found = candidates.find(
      (tab) => tab?.id && tab.url === requestedUrl
    );

    if (!found?.id) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message:
            "No tab with that exact URL belongs to this BrowserHarness task session"
        }
      };
    }

    session = await selectSessionTab(session, found.id);
    return {
      ok: true,
      data: {
        tab_id: found.id,
        url: found.url,
        title: found.title,
        active: Boolean(found.active),
        borrowed: session.borrowed_tab_ids.includes(found.id)
      }
    };
  }

  if (tool === "switch_tab") {
    if (typeof input.tab_id !== "number") {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "tab_id is required"
        }
      };
    }

    if (session) {
      session = await selectSessionTab(session, input.tab_id);
    }

    const tab = await chrome.tabs.update(input.tab_id, {
      active: true
    });
    if (!tab?.id) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "Tab could not be activated"
        }
      };
    }
    return {
      ok: true,
      data: { tab_id: tab.id, url: tab.url }
    };
  }

  if (tool === "close_tab") {
    if (typeof input.tab_id !== "number") {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "tab_id is required"
        }
      };
    }

    if (session && !session.owned_tab_ids.includes(input.tab_id)) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_OWNED",
          message:
            "BrowserHarness will not close a borrowed or unrelated user tab."
        }
      };
    }

    await chrome.tabs.remove(input.tab_id);
    if (session) {
      await removeSessionTab(session, input.tab_id);
    }
    return { ok: true, data: { tab_id: input.tab_id } };
  }

  if (tool === "close_session") {
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message:
            "close_session requires a BrowserHarness task session"
        }
      };
    }

    const sessionId = session.id;
    const closedOwnedTabs = await closeTaskSession(session);
    await clearBrowserWorkingMemory(sessionId).catch(
      () => false
    );
    return {
      ok: true,
      data: {
        session_id: sessionId,
        closed_owned_tabs: closedOwnedTabs,
        borrowed_tabs_preserved: session.borrowed_tab_ids.length
      }
    };
  }

  if (tool === "memory") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "search";

    if (action === "active") {
      const sessionId = session?.id;

      if (!sessionId) {
        return {
          ok: false,
          error: {
            code: "SESSION_REQUIRED",
            message:
              "memory active requires a BrowserHarness task session"
          }
        };
      }

      const memory = await getBrowserWorkingMemory(
        sessionId
      );
      return memory
        ? {
            ok: true,
            data: {
              working_memory: memory
            }
          }
        : {
            ok: false,
            error: {
              code: "WORKING_MEMORY_NOT_FOUND",
              message:
                "No active working memory exists for this task session"
            }
          };
    }

    if (action === "search") {
      if (
        typeof input.query !== "string" ||
        !input.query.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "MEMORY_QUERY_REQUIRED",
            message: "memory search requires query"
          }
        };
      }

      const hits = await searchTaskMemoryHybrid(
        input.query,
        Number(input.limit ?? 10),
        options.spaceId
      );
      return {
        ok: true,
        data: {
          hits,
          episodes: hits.map((hit) => hit.episode)
        }
      };
    }

    if (action === "procedures") {
      if (
        typeof input.query !== "string" ||
        !input.query.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "MEMORY_QUERY_REQUIRED",
            message: "memory procedures requires query"
          }
        };
      }

      return {
        ok: true,
        data: {
          procedures: await searchProceduralMemory(
            input.query,
            Number(input.limit ?? 8)
          )
        }
      };
    }

    if (action === "list") {
      return {
        ok: true,
        data: {
          episodes: await listTaskEpisodeMemory(
            Number(input.limit ?? 50),
            options.spaceId
          )
        }
      };
    }

    if (action === "get") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "MEMORY_ID_REQUIRED",
            message: "memory get requires id"
          }
        };
      }

      const episode = await getTaskEpisodeMemory(input.id, options.spaceId);
      return episode
        ? { ok: true, data: { episode } }
        : {
            ok: false,
            error: {
              code: "MEMORY_NOT_FOUND",
              message: "Task episode memory was not found"
            }
          };
    }

    if (action === "delete") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "MEMORY_ID_REQUIRED",
            message: "memory delete requires id"
          }
        };
      }

      const deleted = await deleteTaskEpisodeMemory(
        input.id,
        options.spaceId
      );
      if (deleted) {
        await deleteTaskEpisodeVector(input.id).catch(
          () => undefined
        );
      }
      return {
        ok: true,
        data: {
          id: input.id,
          deleted
        }
      };
    }

    return {
      ok: false,
      error: {
        code: "MEMORY_ACTION_INVALID",
        message:
          "memory action must be active, search, procedures, list, get, or delete"
      }
    };
  }

  if (tool === "site_skill") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "create";

    if (action === "learn_api") {
      return learnApiTool(input, session);
    }

    if (action === "repair") {
      return repairApiTool(input, session);
    }

    if (action === "verify" && typeof input.id === "string" && input.id.trim()) {
      // a Skill of learned operations is checked by calling them; one with forms by reading the page
      const revision = await getSiteSkillRevision(input.id, typeof input.revision_id === "string" ? input.revision_id : undefined);
      const recipeId = typeof input.recipe_id === "string" ? input.recipe_id : undefined;
      if (revision && apiRecipesOf(revision.candidate, recipeId).length && (recipeId || revision.candidate.recipes.every((recipe) => recipe.form_index < 0))) {
        return apiHealthTool(input.id, revision, recipeId);
      }
    }

    if (action === "run" && input.api_read_only === true) {
      // a helper's run: only a learned API read, never a form or a write
      const revision = typeof input.id === "string"
        ? await getSiteSkillExecutableRevision(input.id, typeof input.revision_id === "string" ? input.revision_id : undefined)
        : null;
      let recipe: import("../runtime/site-skill").SiteSkillRecipe | null = null;
      try {
        recipe = revision ? selectSiteSkillRecipe(revision.candidate, typeof input.recipe_id === "string" ? input.recipe_id : undefined) : null;
      } catch {
        recipe = null;
      }
      const step = recipe?.steps.find((item) => item.kind === "api_operation");
      if (!revision || !recipe || !step || step.kind !== "api_operation" || step.contract.side_effect !== "read") {
        return {
          ok: false,
          error: {
            code: "SUBAGENT_SCOPE_DENIED",
            message: "Helpers may run only a Site Skill's learned API reads (recipes whose id starts with recipe-api-v2- and that only get data)."
          }
        };
      }
      return runApiOperationRecipe(input, revision, recipe.id, { ...options, approvalGranted: false });
    }

    if (action === "run" && typeof input.id === "string" && input.id.trim()) {
      // an API Recipe v2 recipe needs no tab; others fall through to the page path
      const revision = await getSiteSkillExecutableRevision(
        input.id,
        typeof input.revision_id === "string" ? input.revision_id : undefined
      );
      if (revision) {
        try {
          const recipe = selectSiteSkillRecipe(
            revision.candidate,
            typeof input.recipe_id === "string" ? input.recipe_id : undefined
          );
          if (recipe.steps.some((step) => step.kind === "api_operation")) {
            return runApiOperationRecipe(input, revision, recipe.id, options);
          }
        } catch {
          // reported by the page path below with its usual errors
        }
      }
    }

    if (action === "list") {
      return {
        ok: true,
        data: {
          candidates: await listSiteSkillCandidateSummaries()
        }
      };
    }

    if (action === "get") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill get requires id"
          }
        };
      }
      const candidate = await getSiteSkillCandidate(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      return candidate
        ? { ok: true, data: { candidate } }
        : {
            ok: false,
            error: {
              code: "SITE_SKILL_NOT_FOUND",
              message: "Site Skill candidate was not found"
            }
          };
    }

    if (action === "history") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill history requires id"
          }
        };
      }

      const revisions = await listSiteSkillRevisionSummaries(
        input.id
      );
      if (!revisions.length) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }

      const family = await getSiteSkillFamily(input.id);
      return {
        ok: true,
        data: {
          id: input.id,
          latest_revision_id: family?.latest_revision_id,
          active_revision_id: family?.active_revision_id,
          revisions,
          evaluations: family?.evaluations || [],
          executions:
            await listSiteSkillExecutionEvidence(input.id),
          lifecycle_events: family?.lifecycle_events || [],
          promotion_gate:
            await getSiteSkillPromotionGate(input.id),
          comparison:
            await getSiteSkillRevisionComparison(input.id)
        }
      };
    }

    if (action === "compare") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill compare requires id"
          }
        };
      }

      try {
        const comparison =
          await getSiteSkillRevisionComparison(
            input.id,
            typeof input.revision_id === "string"
              ? input.revision_id
              : undefined,
            typeof input.baseline_revision_id === "string"
              ? input.baseline_revision_id
              : undefined
          );
        return comparison
          ? {
              ok: true,
              data: {
                id: input.id,
                comparison
              }
            }
          : {
              ok: false,
              error: {
                code: "SITE_SKILL_NOT_FOUND",
                message: "Site Skill candidate was not found"
              }
            };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_COMPARISON_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill comparison failed"
          }
        };
      }
    }

    if (action === "promote") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill promote requires id"
          }
        };
      }
      const family = await getSiteSkillFamily(input.id);
      if (!family) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }
      const revisionId =
        typeof input.revision_id === "string"
          ? input.revision_id
          : family.latest_revision_id;
      const gate = await getSiteSkillPromotionGate(
        input.id,
        revisionId
      );
      if (!gate?.eligible) {
        return {
          ok: false,
          data: {
            promotion_gate: gate,
            comparison:
              await getSiteSkillRevisionComparison(
                input.id,
                revisionId
              )
          },
          error: {
            code: "SITE_SKILL_PROMOTION_EVIDENCE_REQUIRED",
            message:
              gate?.reasons.join("; ") ||
              "Promotion evidence is incomplete"
          }
        };
      }

      try {
        const comparison =
          await getSiteSkillRevisionComparison(
            input.id,
            revisionId
          );
        const event = await promoteSiteSkillRevision(
          input.id,
          revisionId
        );
        return {
          ok: true,
          data: {
            id: input.id,
            active_revision_id: revisionId,
            comparison,
            event
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_PROMOTION_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill promotion failed"
          }
        };
      }
    }

    if (action === "rollback") {
      if (
        typeof input.id !== "string" ||
        !input.id.trim() ||
        typeof input.revision_id !== "string" ||
        !input.revision_id.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_REVISION_REQUIRED",
            message:
              "site_skill rollback requires id and revision_id"
          }
        };
      }

      try {
        const event = await rollbackSiteSkillRevision(
          input.id,
          input.revision_id
        );
        return {
          ok: true,
          data: {
            id: input.id,
            active_revision_id: input.revision_id,
            event
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ROLLBACK_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill rollback failed"
          }
        };
      }
    }

    if (action === "delete") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill delete requires id"
          }
        };
      }
      return {
        ok: true,
        data: {
          id: input.id,
          deleted: await deleteSiteSkillCandidate(input.id)
        }
      };
    }

    if (
      action !== "create" &&
      action !== "verify" &&
      action !== "run" &&
      action !== "refine" &&
      action !== "history" &&
      action !== "compare" &&
      action !== "promote" &&
      action !== "rollback"
    ) {
      return {
        ok: false,
        error: {
          code: "SITE_SKILL_ACTION_INVALID",
          message:
            "site_skill action must be create, learn_api, verify, run, refine, repair, list, get, history, compare, promote, rollback, or delete"
        }
      };
    }
  }

  const resolved = await targetTab(input, session);
  const tab = resolved.tab;
  session = resolved.session;
  const tabId = tab.id!;

  if (
    input.element_id === GOOGLE_DOCS_EDITOR_ID &&
    ["click", "trusted_click", "type", "trusted_type"].includes(tool)
  ) {
    return googleDocsEditorAction(tabId, tool, input);
  }

  if (tool === "site_skill") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "create";

    if (!tab.url || !isInjectableUrl(tab.url)) {
      return {
        ok: false,
        error: {
          code: "SITE_SKILL_UNSUPPORTED_PAGE",
          message:
            "Site Skill creation requires an http(s) page"
        }
      };
    }

    if (action === "refine") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill refine requires id"
          }
        };
      }

      const baseRevision = await getSiteSkillExecutableRevision(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      if (!baseRevision) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }

      try {
        const fresh = await collectCurrentSiteSkill({
          tab_id: tabId,
          url: tab.url,
          title: tab.title || new URL(tab.url).hostname,
          requested_name: baseRevision.candidate.name,
          include_network: input.include_network !== false
        });
        const proposal = createRefinedSiteSkillCandidate(
          baseRevision.candidate,
          fresh.candidate
        );

        if (!proposal.diff.changed) {
          return {
            ok: true,
            data: {
              id: input.id,
              base_revision_id: baseRevision.revision_id,
              refinement_needed: false,
              diff: proposal.diff,
              message:
                "Fresh site evidence matches the existing Skill contract; no revision was created."
            }
          };
        }

        const verification = verifySiteSkillCandidate(
          proposal.candidate,
          fresh.evidence
        );
        if (verification.status !== "verified") {
          return {
            ok: false,
            data: {
              base_revision_id: baseRevision.revision_id,
              diff: proposal.diff,
              verification
            },
            error: {
              code: "SITE_SKILL_REFINEMENT_VERIFICATION_FAILED",
              message:
                "Fresh refinement candidate did not verify against the evidence that produced it"
            }
          };
        }

        proposal.candidate.verification = verification;
        const revision = await saveSiteSkillCandidate(
          proposal.candidate,
          { reason: "refinement" }
        );
        await recordSiteSkillEvaluation(
          input.id,
          revision.revision_id,
          {
            kind: "structural-verification",
            outcome: "passed",
            detail:
              `Refinement candidate verified against fresh evidence ${fresh.evidence.evidence_id}`
          }
        );

        const family = await getSiteSkillFamily(input.id);
        return {
          ok: true,
          data: {
            id: input.id,
            base_revision_id: baseRevision.revision_id,
            proposed_revision_id: revision.revision_id,
            active_revision_id: family?.active_revision_id,
            refinement_needed: true,
            diff: proposal.diff,
            verification,
            promotion_gate:
              await getSiteSkillPromotionGate(
                input.id,
                revision.revision_id
              )
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_REFINEMENT_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill refinement failed"
          }
        };
      }
    }

    if (action === "run") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill run requires id"
          }
        };
      }

      const revision = await getSiteSkillExecutableRevision(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      if (!revision) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }
      const existing = revision.candidate;

      try {
        const recipe = selectSiteSkillRecipe(
          existing,
          typeof input.recipe_id === "string"
            ? input.recipe_id
            : undefined
        );
        if (recipe.form_index < 0) {
          // API recipe: read-only GET against the page's own origin; no form verification or approval needed.
          const apiParameters =
            input.parameters &&
            typeof input.parameters === "object" &&
            !Array.isArray(input.parameters)
              ? (input.parameters as Record<string, unknown>)
              : {};
          const apiStartedAt = new Date().toISOString();
          const apiEvidenceId =
            existing.provenance.evidence_id;
          try {
            const run = await runSiteSkillRecipe({
              tab_id: tabId,
              candidate: existing,
              recipe_id: recipe.id,
              parameters: apiParameters
            });
            await recordSiteSkillEvaluation(
              input.id,
              revision.revision_id,
              {
                kind: "execution",
                outcome: "passed",
                detail: `API recipe ${recipe.id} returned HTTP ${run.output?.http_status}`
              }
            );
            const execution =
              await recordSiteSkillExecutionEvidence(
                input.id,
                revision.revision_id,
                {
                  recipe_id: recipe.id,
                  started_at: apiStartedAt,
                  outcome: "passed",
                  evidence_id: apiEvidenceId,
                  executed_steps: run.executed_steps,
                  submitted: false,
                  parameter_names: Object.keys(apiParameters).sort()
                }
              );
            return {
              ok: true,
              data: {
                candidate_id: existing.id,
                revision_id: revision.revision_id,
                run,
                execution
              }
            };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Site Skill API recipe failed";
            const code =
              error instanceof SiteSkillRunError && error.code
                ? error.code
                : "SITE_SKILL_RUN_FAILED";
            await recordSiteSkillEvaluation(
              input.id,
              revision.revision_id,
              {
                kind: "execution",
                outcome: "failed",
                detail: message
              }
            ).catch(() => undefined);
            await recordSiteSkillExecutionEvidence(
              input.id,
              revision.revision_id,
              {
                recipe_id: recipe.id,
                started_at: apiStartedAt,
                outcome: "failed",
                evidence_id: apiEvidenceId,
                executed_steps: 0,
                submitted: error instanceof SiteSkillRunError ? error.submitted : false,
                parameter_names: Object.keys(apiParameters).sort(),
                error_code: code,
                error_message: message
              }
            ).catch(() => null);
            // a write that may have run is never offered again
            const ambiguous = code === "API_AMBIGUOUS_WRITE";
            return {
              ok: false,
              data: {
                candidate_id: existing.id,
                revision_id: revision.revision_id,
                refinement_recommended: !ambiguous,
                next_action: ambiguous
                  ? "check the site to see whether it happened; do not run it again"
                  : "site_skill refine"
              },
              error: { code, message }
            };
          }
        }
        const fresh = await collectCurrentSiteSkill({
          tab_id: tabId,
          url: tab.url,
          title: tab.title || new URL(tab.url).hostname,
          requested_name: existing.name,
          include_network: input.include_network !== false
        });
        const verification = verifySiteSkillCandidate(
          existing,
          fresh.evidence
        );

        await recordSiteSkillEvaluation(
          input.id,
          revision.revision_id,
          {
            kind: "structural-verification",
            outcome:
              verification.status === "verified"
                ? "passed"
                : "failed",
            detail:
              verification.status === "verified"
                ? "Fresh site structure matched the revision contract"
                : "Fresh site structure did not match the revision contract"
          }
        );

        if (verification.status !== "verified") {
          return {
            ok: false,
            data: {
              revision_id: revision.revision_id,
              verification,
              evidence_id: fresh.evidence.evidence_id,
              refinement_recommended: true,
              next_action: "site_skill refine"
            },
            error: {
              code: "SITE_SKILL_VERIFICATION_FAILED",
              message:
                "Site Skill revision no longer matches fresh site evidence"
            }
          };
        }

        const submitStep = recipe.steps.find(
          (step) => step.kind === "submit"
        );
        const submitLabel =
          submitStep?.target?.accessible_name || recipe.name;
        const requiresApproval = Boolean(
          submitStep &&
            (submitStep.method.toUpperCase() !== "GET" ||
              isRiskyTrustedLabel(submitLabel))
        );

        if (requiresApproval && !options.approvalGranted) {
          return {
            ok: false,
            data: {
              revision_id: revision.revision_id,
              verification
            },
            error: {
              code: "APPROVAL_REQUIRED",
              message:
                `Run Site Skill “${existing.name}” recipe “${recipe.name}” and submit on ${new URL(tab.url).hostname}?`
            }
          };
        }

        const parameters =
          input.parameters &&
          typeof input.parameters === "object" &&
          !Array.isArray(input.parameters)
            ? (input.parameters as Record<string, unknown>)
            : {};
        const executionStartedAt = new Date().toISOString();
        const parameterNames = Object.keys(parameters).sort();

        try {
          const run = await runSiteSkillRecipe({
            tab_id: tabId,
            candidate: existing,
            recipe_id: recipe.id,
            parameters
          });

          await recordSiteSkillEvaluation(
            input.id,
            revision.revision_id,
            {
              kind: "execution",
              outcome: "passed",
              detail:
                `Recipe ${recipe.id} completed through its verified submit boundary`
            }
          );
          const execution =
            await recordSiteSkillExecutionEvidence(
              input.id,
              revision.revision_id,
              {
                recipe_id: recipe.id,
                started_at: executionStartedAt,
                outcome: "passed",
                evidence_id: fresh.evidence.evidence_id,
                executed_steps: run.executed_steps,
                submitted: run.submitted,
                parameter_names: parameterNames
              }
            );

          return {
            ok: true,
            data: {
              candidate_id: existing.id,
              revision_id: revision.revision_id,
              verification,
              run,
              execution
            }
          };
        } catch (error) {
          const runError =
            error instanceof SiteSkillRunError ? error : null;
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Site Skill execution failed";
          const errorCode =
            runError?.code || "SITE_SKILL_RUN_FAILED";

          await recordSiteSkillEvaluation(
            input.id,
            revision.revision_id,
            {
              kind: "execution",
              outcome: "failed",
              detail: errorMessage
            }
          ).catch(() => undefined);

          const execution =
            await recordSiteSkillExecutionEvidence(
              input.id,
              revision.revision_id,
              {
                recipe_id: recipe.id,
                started_at: executionStartedAt,
                outcome: "failed",
                evidence_id: fresh.evidence.evidence_id,
                executed_steps:
                  runError?.executed_steps || 0,
                submitted: runError?.submitted === true,
                parameter_names: parameterNames,
                error_code: errorCode,
                error_message: errorMessage
              }
            ).catch(() => null);

          return {
            ok: false,
            data: {
              candidate_id: existing.id,
              revision_id: revision.revision_id,
              verification,
              execution,
              refinement_recommended: true,
              next_action: "site_skill refine"
            },
            error: {
              code: "SITE_SKILL_RUN_FAILED",
              message: errorMessage
            }
          };
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_RUN_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill execution failed"
          }
        };
      }
    }

    if (action === "verify") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill verify requires id"
          }
        };
      }

      const revision = await getSiteSkillRevision(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      if (!revision) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }
      const existing = revision.candidate;

      try {
        const fresh = await collectCurrentSiteSkill({
          tab_id: tabId,
          url: tab.url,
          title: tab.title || new URL(tab.url).hostname,
          requested_name: existing.name,
          include_network: input.include_network !== false
        });
        const verification = verifySiteSkillCandidate(
          existing,
          fresh.evidence
        );

        await recordSiteSkillEvaluation(
          input.id,
          revision.revision_id,
          {
            kind: "structural-verification",
            outcome:
              verification.status === "verified"
                ? "passed"
                : "failed",
            detail:
              verification.status === "verified"
                ? "Fresh site structure matched the revision contract"
                : "Fresh site structure did not match the revision contract"
          }
        );

        return {
          ok: verification.status === "verified",
          data: {
            candidate: {
              ...existing,
              verification
            },
            revision_id: revision.revision_id,
            verification
          },
          ...(verification.status === "failed"
            ? {
                error: {
                  code: "SITE_SKILL_VERIFICATION_FAILED",
                  message:
                    "Site Skill revision no longer matches fresh site evidence"
                }
              }
            : {})
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_VERIFICATION_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill verification failed"
          }
        };
      }
    }

    try {
      const created = await collectCurrentSiteSkill({
        tab_id: tabId,
        url: tab.url,
        title: tab.title || new URL(tab.url).hostname,
        requested_name:
          typeof input.name === "string" ? input.name : undefined,
        include_network: input.include_network !== false
      });
      const revision = await saveSiteSkillCandidate(
        created.candidate,
        { reason: "create" }
      );

      return {
        ok: true,
        data: {
          candidate: created.candidate,
          revision_id: revision.revision_id,
          evidence_summary: {
            ax_target_count: created.evidence.ax.target_count,
            form_count: created.evidence.forms.length,
            network_request_count: created.evidence.network.length
          },
          persisted: true
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SITE_SKILL_CREATE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Site Skill creation failed"
        }
      };
    }
  }

  if (tool === "back") {
    try {
      return {
        ok: true,
        data: {
          ...(await goBackAndWait(tabId)),
          session_id: session?.id
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "BACK_NAVIGATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Back navigation failed"
        }
      };
    }
  }

  if (tool === "reload") {
    try {
      return {
        ok: true,
        data: {
          ...(await reloadAndWait(tabId, {
            bypassCache: input.bypass_cache === true
          })),
          session_id: session?.id
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "RELOAD_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Reload failed"
        }
      };
    }
  }

  if (tool === "navigate") {
    if (typeof input.url !== "string") {
      return {
        ok: false,
        error: {
          code: "NAVIGATION_FAILED",
          message: "url is required"
        }
      };
    }
    const updated = await chrome.tabs.update(tabId, {
      url: input.url
    });
    if (!updated?.id) {
      return {
        ok: false,
        error: {
          code: "NAVIGATION_FAILED",
          message: "Chrome did not return the navigated tab"
        }
      };
    }
    try {
      const ready = await waitForTabUsable(updated.id);
      return {
        ok: true,
        data: {
          ...ready,
          requested_url: input.url,
          session_id: session?.id
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "NAVIGATION_TIMEOUT",
          message:
            error instanceof Error
              ? error.message
              : "Page did not become usable after navigation"
        }
      };
    }
  }

  if (tool === "read_page") {
    try {
      return {
        ok: true,
        data: await readPage(tabId, input)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "READ_PAGE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "BrowserHarness could not read this page"
        }
      };
    }
  }

  if (tool === "ax_snapshot") {
    try {
      const maxElements = Math.min(
        Math.max(Number(input.max_elements ?? 300), 25),
        1000
      );
      return {
        ok: true,
        data: await captureAxSnapshot(tabId, maxElements)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "AX_SNAPSHOT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Accessibility snapshot failed"
        }
      };
    }
  }

  if (tool === "find") {
    const query =
      typeof input.query === "string" ? input.query.trim() : "";
    const role =
      typeof input.role === "string" ? input.role.trim() : "";

    if (!query && !role) {
      return {
        ok: false,
        error: {
          code: "FIND_QUERY_REQUIRED",
          message: "find requires query, role, or both"
        }
      };
    }

    try {
      const snapshot = await captureAxSnapshot(tabId, 1000);
      const matches = findAxElements(snapshot, {
        query,
        role,
        limit: Number(input.limit ?? 20)
      });
      return {
        ok: true,
        data: {
          tab_id: tabId,
          query,
          role,
          scanned: snapshot.elements.length,
          matches
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "FIND_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Semantic find failed"
        }
      };
    }
  }

  if (tool === "evaluate") {
    if (
      typeof input.expression !== "string" ||
      !input.expression.trim()
    ) {
      return {
        ok: false,
        error: {
          code: "EVALUATE_EXPRESSION_REQUIRED",
          message: "evaluate requires a non-empty expression"
        }
      };
    }

    try {
      const maxChars = Math.min(
        Math.max(Number(input.max_chars ?? 50_000), 1_000),
        100_000
      );
      return {
        ok: true,
        data: await evaluatePageExpression(
          tabId,
          input.expression,
          maxChars
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "EVALUATE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Page evaluation failed"
        }
      };
    }
  }

  if (tool === "select_option") {
    if (typeof input.element_id !== "string") {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "select_option requires element_id"
        }
      };
    }

    const rawValues = Array.isArray(input.values)
      ? input.values
      : typeof input.value === "string"
        ? [input.value]
        : [];

    if (rawValues.some((value) => typeof value !== "string")) {
      return {
        ok: false,
        error: {
          code: "SELECT_OPTION_INPUT_INVALID",
          message: "select_option values must be strings"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await selectOptions(
          tabId,
          input.element_id,
          rawValues as string[]
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SELECT_OPTION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Select option failed"
        }
      };
    }
  }

  if (tool === "hover") {
    if (typeof input.element_id !== "string") {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "hover requires element_id"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedHover(tabId, input.element_id)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "HOVER_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Hover failed"
        }
      };
    }
  }

  if (tool === "drag") {
    if (
      typeof input.source_element_id !== "string" ||
      typeof input.target_element_id !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message:
            "drag requires source_element_id and target_element_id"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedDrag(
          tabId,
          input.source_element_id,
          input.target_element_id,
          Number(input.steps ?? 8)
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "DRAG_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Drag failed"
        }
      };
    }
  }

  if (tool === "trusted_click") {
    if (typeof input.element_id !== "string") {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "trusted_click requires element_id"
        }
      };
    }

    // Refs from observe_page work here too, so look the name up when the
    // ref did not come from the latest ax_snapshot.
    let label = elementForAxRef(tabId, input.element_id)?.name || "";
    if (!label) {
      label = await accessibleNameForRef(tabId, input.element_id).catch(() => "");
    }
    const risky = isRiskyTrustedLabel(label);

    if (risky && !options.approvalGranted) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: `Trusted click “${label || input.element_id}” requires explicit approval.`
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedClick(tabId, input.element_id)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRUSTED_CLICK_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted click failed"
        }
      };
    }
  }

  if (tool === "trusted_type") {
    if (
      typeof input.element_id !== "string" ||
      typeof input.text !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message:
            "trusted_type requires element_id and text"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedType(
          tabId,
          input.element_id,
          input.text
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRUSTED_TYPE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted text input failed"
        }
      };
    }
  }

  if (tool === "trusted_key") {
    if (typeof input.key !== "string" || !input.key) {
      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "trusted_key requires key"
        }
      };
    }

    if (input.key === "Enter") {
      try {
        const snapshot = await captureAxSnapshot(tabId, 300);
        const focused = snapshot.elements.find(
          (element) => element.focused
        );
        if (
          focused &&
          isRiskyTrustedLabel(focused.name) &&
          !options.approvalGranted
        ) {
          return {
            ok: false,
            error: {
              code: "APPROVAL_REQUIRED",
              message: `Trusted Enter in “${focused.name || focused.role}” requires explicit approval.`
            }
          };
        }
      } catch {
        // If AX metadata is unavailable, continue; browser-engine approval
        // still applies to ordinary semantic controls.
      }
    }

    try {
      return {
        ok: true,
        data: await trustedKey(tabId, input.key)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRUSTED_KEY_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted key input failed"
        }
      };
    }
  }

  if (tool === "send_keys") {
    if (typeof input.keys !== "string" || !input.keys.trim()) {
      return {
        ok: false,
        error: {
          code: "SEND_KEYS_INPUT_INVALID",
          message:
            'send_keys requires keys, e.g. "Enter", "Mod+A", "Shift+Tab", or "Enter Escape"'
        }
      };
    }

    const repeat = Number(input.repeat ?? 1);

    try {
      const platformInfo = await chrome.runtime.getPlatformInfo();
      const sequence = parseTrustedKeySequence(
        input.keys,
        platformInfo.os
      );

      if (
        sequence.some((chord) => chord.key.key === "Enter") &&
        !options.approvalGranted
      ) {
        try {
          const snapshot = await captureAxSnapshot(tabId, 300);
          const focused = snapshot.elements.find(
            (element) => element.focused
          );
          if (
            focused &&
            isRiskyTrustedLabel(focused.name)
          ) {
            return {
              ok: false,
              error: {
                code: "APPROVAL_REQUIRED",
                message:
                  `Trusted key sequence containing Enter in “${focused.name || focused.role}” requires explicit approval.`
              }
            };
          }
        } catch {
          // AX evidence is best-effort here; parser/runtime validation
          // still applies and BrowserHarness can re-observe after dispatch.
        }
      }

      return {
        ok: true,
        data: await trustedSendKeys(
          tabId,
          input.keys,
          repeat,
          platformInfo.os
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SEND_KEYS_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted key sequence failed"
        }
      };
    }
  }

  if (tool === "dialog") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "status";

    if (action === "status") {
      return {
        ok: true,
        data: {
          open: Boolean(getJavaScriptDialog(tabId)),
          dialog: getJavaScriptDialog(tabId)
        }
      };
    }

    if (action !== "accept" && action !== "dismiss") {
      return {
        ok: false,
        error: {
          code: "DIALOG_ACTION_INVALID",
          message:
            "dialog action must be status, accept, or dismiss"
        }
      };
    }

    try {
      await handleJavaScriptDialog(
        tabId,
        action === "accept",
        typeof input.prompt_text === "string"
          ? input.prompt_text
          : undefined
      );
      return {
        ok: true,
        data: { action }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "DIALOG_ACTION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Dialog action failed"
        }
      };
    }
  }

  if (tool === "network") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "list";

    try {
      if (action === "start") {
        await startNetworkCapture(
          tabId,
          Number(input.max_entries ?? 500)
        );
        return {
          ok: true,
          data: {
            active: true,
            tab_id: tabId
          }
        };
      }

      if (action === "list") {
        return {
          ok: true,
          data: {
            active: networkCaptureActive(tabId),
            requests: listNetworkRecords(
              tabId,
              Number(input.limit ?? 100)
            )
          }
        };
      }

      if (action === "detail") {
        if (typeof input.request_id !== "string") {
          return {
            ok: false,
            error: {
              code: "NETWORK_REQUEST_ID_REQUIRED",
              message:
                "network detail requires request_id"
            }
          };
        }
        return {
          ok: true,
          data: await networkRecordDetail(
            tabId,
            input.request_id,
            input.include_body !== false
          )
        };
      }

      if (action === "stop") {
        return {
          ok: true,
          data: await stopNetworkCapture(tabId)
        };
      }

      return {
        ok: false,
        error: {
          code: "NETWORK_ACTION_INVALID",
          message:
            "network action must be start, list, detail, or stop"
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "NETWORK_CAPTURE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Network capture failed"
        }
      };
    }
  }

  if (tool === "upload") {
    if (
      typeof input.element_id === "string" &&
      Array.isArray(input.attachment_ids) &&
      input.attachment_ids.length > 0 &&
      input.attachment_ids.every((id) => typeof id === "string")
    ) {
      try {
        const records = await getAttachmentsByIds(
          input.attachment_ids as string[]
        );
        return {
          ok: true,
          data: await uploadAttachments(
            tabId,
            input.element_id,
            records
          )
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "UPLOAD_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Attachment upload failed"
          }
        };
      }
    }

    if (
      typeof input.element_id !== "string" ||
      !Array.isArray(input.files) ||
      input.files.some((file) => typeof file !== "string")
    ) {
      return {
        ok: false,
        error: {
          code: "UPLOAD_INPUT_INVALID",
          message:
            "upload requires element_id and files:string[]"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await uploadFiles(
          tabId,
          input.element_id,
          input.files as string[]
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "UPLOAD_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "File upload failed"
        }
      };
    }
  }

  if (tool === "save_pdf") {
    try {
      return {
        ok: true,
        data: await savePageAsPdf(tabId, {
          filename:
            typeof input.filename === "string"
              ? input.filename
              : undefined,
          landscape: Boolean(input.landscape),
          print_background:
            input.print_background !== false,
          scale:
            typeof input.scale === "number"
              ? input.scale
              : undefined,
          save_as: input.save_as === true
        })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "PDF_EXPORT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "PDF export failed"
        }
      };
    }
  }

  if (tool === "cdp") {
    if (typeof input.method !== "string" || !input.method.trim()) {
      return {
        ok: false,
        error: {
          code: "CDP_METHOD_REQUIRED",
          message: "cdp requires a DevTools protocol method"
        }
      };
    }

    const params =
      input.params &&
      typeof input.params === "object" &&
      !Array.isArray(input.params)
        ? (input.params as Record<string, unknown>)
        : {};

    try {
      return {
        ok: true,
        data: await cdpCommand(
          tabId,
          input.method.trim(),
          params
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "CDP_COMMAND_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "CDP command failed"
        }
      };
    }
  }

  if (tool === "screenshot") {
    try {
      const captured = await captureCdpScreenshot(tabId, {
        ...(typeof input.element_id === "string"
          ? { element_id: input.element_id }
          : {}),
        full_page: input.full_page === true
      });
      return {
        ok: true,
        data: {
          tab_id: tabId,
          data_url: captured.data_url,
          mode: captured.mode
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SCREENSHOT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "CDP screenshot failed"
        }
      };
    }
  }

  if (tool === "extract_table") {
    return sendToTab(tabId, { type: "EXTRACT_TABLES" });
  }

  if (tool === "observe_page") {
    return sendToTab(tabId, {
      type: "OBSERVE_PAGE",
      tab_id: tabId
    });
  }

  if (tool === "press_key" && typeof input.key === "string" && input.key) {
    // Real key presses: a synthetic Enter does not submit search boxes or
    // forms on most sites.
    if (typeof input.element_id === "string") {
      const focused = await sendToTab(tabId, {
        type: "EXECUTE_CONTENT_ACTION",
        action: "focus",
        input: { element_id: input.element_id }
      });
      if (!focused.ok) return focused;
    }
    try {
      const platformInfo = await chrome.runtime.getPlatformInfo();
      await trustedSendKeys(tabId, input.key, 1, platformInfo.os);
      return { ok: true, data: { key: input.key, mode: "keyboard" } };
    } catch {
      // Debugger unavailable or an unusual key: use page-level events.
    }
  }

  if (
    ["click", "type", "press_key", "scroll"].includes(tool)
  ) {
    return sendToTab(tabId, {
      type: "EXECUTE_CONTENT_ACTION",
      action: tool,
      input
    });
  }

  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `Unknown tool: ${tool}`
    }
  };
}

const BRIDGE_TOOL_NAMES = new Set<ToolName>([
  "observe_page",
  "read_page",
  "ax_snapshot",
  "find",
  "evaluate",
  "site_skill",
  "memory",
  "mcp",
  "select_option",
  "hover",
  "drag",
  "trusted_click",
  "trusted_type",
  "trusted_key",
  "send_keys",
  "dialog",
  "network",
  "upload",
  "save_pdf",
  "extract_table",
  "skills",
  "site_commands",
  "cdp",
  "navigate",
  "back",
  "reload",
  "click",
  "type",
  "press_key",
  "scroll",
  "wait",
  "open_tab",
  "find_tab",
  "list_tabs",
  "switch_tab",
  "close_tab",
  "close_session",
  "screenshot"
]);


/**
 * "/schedule every weekday at 8am check prices" from a chat app: saves the
 * schedule with results going back to that app, and answers at once.
 */
async function scheduleFromChat(words: string, from: string): Promise<ToolResult> {
  const id = crypto.randomUUID();
  const parsed = parseScheduleText(words);
  const app = isChatApp(from) ? from : undefined;
  if (!parsed || !parsed.task) {
    return {
      ok: true,
      data: {
        id,
        reply: "Tell me when and what, like “/schedule every weekday at 8am check my inbox for invoices”."
      }
    };
  }
  const item = { ...newScheduledTask(parsed.task, parsed.schedule), deliver_to: app };
  if (!item.next_run_at) return { ok: true, data: { id, reply: "That time has already passed. Pick a time in the future." } };
  await saveScheduledTask(item);
  return {
    ok: true,
    data: {
      id,
      reply: `Scheduled: ${item.task}\n${describeSchedule(item.schedule)}. ${app ? `I'll send each result here.` : ""} It runs while Chrome is open on your computer; turn it off under History → Scheduled.`
    }
  };
}

async function runningChatTasks(): Promise<Record<string, RunningChatTask>> {
  const stored = ((await chrome.storage.session.get(RUNNING_CHAT_TASKS_KEY))[RUNNING_CHAT_TASKS_KEY] || {}) as Record<string, RunningChatTask>;
  // A runner tab someone closed is no longer running.
  const alive: Record<string, RunningChatTask> = {};
  for (const [id, task] of Object.entries(stored)) {
    if (await chrome.tabs.get(task.tab_id).then(() => true, () => false)) alive[id] = task;
  }
  if (Object.keys(alive).length !== Object.keys(stored).length) await chrome.storage.session.set({ [RUNNING_CHAT_TASKS_KEY]: alive });
  return alive;
}

async function forgetRunningChatTask(id: string): Promise<void> {
  const stored = ((await chrome.storage.session.get(RUNNING_CHAT_TASKS_KEY))[RUNNING_CHAT_TASKS_KEY] || {}) as Record<string, RunningChatTask>;
  if (!(id in stored)) return;
  const { [id]: _done, ...rest } = stored;
  await chrome.storage.session.set({ [RUNNING_CHAT_TASKS_KEY]: rest });
}

/** /status, /stop, /schedules and /unschedule from a chat app, answered at once. */
async function chatCommandReply(text: string, from: string): Promise<string | null> {
  const command = parseChatCommand(text);
  if (!command) return null;
  if (command.kind === "status") {
    return statusText(Object.values(await runningChatTasks()), await loadSchedules());
  }
  if (command.kind === "stop") {
    const mine = Object.values(await runningChatTasks()).filter((task) => task.from === from);
    if (!mine.length) return "Nothing you started here is running.";
    const label = isChatApp(from) ? CHAT_APP_LABELS[from] : "your phone";
    for (const task of mine) {
      await chrome.tabs.remove(task.tab_id).catch(() => undefined);
      await forgetRunningChatTask(task.id);
      sendBridgeEvent({ type: "remote_task_result", id: task.id, status: "failed", message: `You stopped it from ${label}.` });
    }
    return `Stopped: ${mine.map((task) => task.text).join("; ")}`;
  }
  if (command.kind === "schedules") return schedulesText(await loadSchedules());
  const choice = scheduleToTurnOff(await loadSchedules(), command.number);
  if ("reply" in choice) return choice.reply;
  await setScheduleEnabled(choice.item.id, false);
  return `Turned off: ${choice.item.task}
Turn it back on under History → Scheduled.`;
}

/** A task sent from a chat app (Telegram, Discord, Slack or Signal, via the Bridge). */
async function startRemoteTask(args: Record<string, unknown>): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text.trim().slice(0, 4000) : "";
  if (!text) {
    return { ok: false, error: { code: "EMPTY_TASK", message: "The message had no task in it." } };
  }
  const from = typeof args.from === "string" ? args.from : "phone";
  if (/^\/schedule\b/i.test(text)) return scheduleFromChat(text.replace(/^\/schedule\s*/i, ""), from);
  const reply = await chatCommandReply(text, from);
  if (reply !== null) return { ok: true, data: { id: crypto.randomUUID(), reply } };
  // The Space is captured now, as the message arrives, not when the runner starts.
  const id = await enqueueRemoteTask(text, from);
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`runner.html?remote=${encodeURIComponent(id)}`),
    active: false
  });
  if (tab.id !== undefined) {
    const running = ((await chrome.storage.session.get(RUNNING_CHAT_TASKS_KEY))[RUNNING_CHAT_TASKS_KEY] || {}) as Record<string, RunningChatTask>;
    await chrome.storage.session.set({
      [RUNNING_CHAT_TASKS_KEY]: { ...running, [id]: { id, text, from, tab_id: tab.id, started_at: new Date().toISOString() } }
    });
  }
  return { ok: true, data: { id } };
}

async function handleBridgeCommand(
  command: BridgeCommand
): Promise<ToolResult & { page?: PageObservation }> {
  if (command.action === "remote_task") {
    return startRemoteTask(command.args);
  }
  if (!BRIDGE_TOOL_NAMES.has(command.action as ToolName)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_BRIDGE_ACTION",
        message: `Unsupported BrowserHarness Bridge action: ${command.action}`
      }
    };
  }

  const tool = command.action as ToolName;

  if (
    tool === "click" ||
    (tool === "press_key" &&
      String(command.args.key || "") === "Enter")
  ) {
    const observed = await runTool(
      "observe_page",
      {},
      command.session,
      command.title
    );

    if (!observed.ok || !observed.data) {
      return observed;
    }

    const observation = observed.data as PageObservation;
    const elementId = command.args.element_id;
    const element =
      typeof elementId === "string"
        ? observation.elements.find(
            (candidate) =>
              candidate.element_id === elementId ||
              candidate.semantic_ref === elementId
          )
        : undefined;

    const requiresApproval =
      tool === "click"
        ? element?.requires_approval
        : element?.enter_requires_approval;

    if (requiresApproval) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message:
            element?.approval_reason ||
            "This browser action requires explicit user approval in BrowserHarness."
        }
      };
    }
  }

  // Agents get the page as it looks after the action, so they do not need
  // a separate observe_page call per step. observe:false turns this off.
  const { observe: returnPage, ...args } = command.args;
  const result = await runTool(tool, args, command.session, command.title);
  if (!result.ok || returnPage === false || !changesPage(tool, args)) {
    return result;
  }
  const settleMs = settleMsAfter(tool);
  if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
  const page = await runTool(
    "observe_page",
    observationInputAfter(args, result),
    command.session,
    command.title
  );
  return page.ok && page.data ? { ...result, page: page.data as PageObservation } : result;
}

async function armWatchTab(tabId: number): Promise<ToolResult> {
  return sendToTab(tabId, { type: "WATCH_ARM" });
}

async function disarmWatchTab(
  tabId: number
): Promise<RecordedWorkflowStep | null> {
  const result = await sendToTab(tabId, {
    type: "WATCH_DISARM"
  });

  if (!result.ok || !result.data) return null;

  const data = result.data as {
    final_step?: RecordedWorkflowStep;
  };
  return data.final_step || null;
}

const watchBrowserEvents = createWatchBrowserEventHandlers({
  armWatchTab
});

chrome.webNavigation.onCommitted.addListener(
  watchBrowserEvents.onCommitted
);
chrome.webNavigation.onCompleted.addListener(
  watchBrowserEvents.onCompleted
);
chrome.tabs.onCreated.addListener(
  watchBrowserEvents.onCreated
);
chrome.tabs.onActivated.addListener(
  watchBrowserEvents.onActivated
);
chrome.tabs.onRemoved.addListener(
  watchBrowserEvents.onRemoved
);

startBridgeClient(handleBridgeCommand);

chrome.runtime.onMessage.addListener(
  (
    request: ExtensionRequest,
    sender,
    sendResponse
  ) => {
    void (async () => {
      try {
        if (request.type === "CHAT_NOTIFY") {
          if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("runner.html")) || !isChatApp(request.app)) {
            sendResponse({ ok: false });
            return;
          }
          sendResponse({ ok: sendBridgeEvent({ type: "chat_notify", app: request.app, text: String(request.text || "").slice(0, 4000) }) });
          return;
        }
        if (request.type === "REMOTE_TASK_RESULT") {
          if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("runner.html"))) {
            sendResponse({ ok: false });
            return;
          }
          await forgetRunningChatTask(String(request.id));
          sendResponse({
            ok: sendBridgeEvent({
              type: "remote_task_result",
              id: request.id,
              status: request.status,
              message: request.message,
              url: request.url
            })
          });
          return;
        }
        if (request.type === "BRIDGE_CHAT") {
          // Chat app tokens only come from BrowserHarness's own Settings page.
          if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
            sendResponse({
              ok: false,
              error: { code: "FORBIDDEN", message: "Chat apps can only be set up from BrowserHarness pages" }
            });
            return;
          }
          const allowed = ["status", "setup", "allow", "remove", "off"];
          if (!allowed.includes(request.action)) {
            sendResponse({ ok: false, error: { code: "BAD_REQUEST", message: "Unknown chat app action" } });
            return;
          }
          // An older helper app never answers, so the status check gives up sooner.
          sendResponse(
            await requestBridgeChat(
              request.action,
              request.args && typeof request.args === "object" ? request.args : {},
              request.action === "status" ? 8000 : 60_000
            )
          );
          return;
        }
        if (request.type === "BRIDGE_LLM") {
          // Content scripts share our id but report the page URL: only extension pages may spend the subscription.
          if (
            sender.id !== chrome.runtime.id ||
            !sender.url?.startsWith(chrome.runtime.getURL(""))
          ) {
            sendResponse({
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: "Subscription requests are only accepted from BrowserHarness pages"
              }
            });
            return;
          }
          const result = await requestBridgeLlm(
            request.action,
            request.action === "status"
              ? { adapter: request.adapter }
              : {
                  adapter: request.adapter,
                  model: request.model,
                  system: request.system,
                  prompt: request.prompt,
                  timeout_ms: request.timeout_ms
                }
          );
          sendResponse(result);
          return;
        }

        if (request.type === "GET_CURRENT_TAB") {
          const tab = (await activeWebTab(false)) ?? (await activeTab());
          sendResponse({
            ok: true,
            data: {
              tab_id: tab.id,
              title: tab.title,
              url: tab.url,
              fav_icon_url: tab.favIconUrl
            }
          });
          return;
        }

        if (request.type === "BROWSER_TOOL") {
          const approvalGranted =
            extensionPageApprovalGranted(
              request.approval_granted,
              sender,
              chrome.runtime.id,
              chrome.runtime.getURL("")
            );

          sendResponse(
            await runTool(
              request.tool,
              request.input,
              request.session_id,
              request.session_title,
              {
                approvalGranted,
                spaceId: request.space_id || undefined
              }
            )
          );
          return;
        }

        if (request.type === "WATCH_STATUS") {
          const active = await getWatchRecording();
          sendResponse({
            ok: true,
            data: active
              ? {
                  recording: true,
                  recording_id: active.id,
                  started_at: active.started_at,
                  root_tab_id: active.root_tab_id,
                  current_tab_id: active.current_tab_id,
                  tab_count: active.tab_ids.length,
                  step_count: active.steps.length,
                  event_count: active.events.length,
                  boundary_step_id: active.boundary_step_id
                }
              : {
                  recording: false
                }
          });
          return;
        }

        if (request.type === "WATCH_START") {
          const resolved = await targetTab(
            typeof request.tab_id === "number"
              ? { tab_id: request.tab_id }
              : {}
          );

          const session = await startWatchRecording(resolved.tab);
          const armed = await armWatchTab(resolved.tab.id!);

          if (!armed.ok) {
            await stopWatchRecording();
            sendResponse(armed);
            return;
          }
          await beginWatchApiCapture(session.id, resolved.tab.id!);

          sendResponse({
            ok: true,
            data: {
              recording: true,
              recording_id: session.id,
              root_tab_id: session.root_tab_id,
              start_url: session.start_url
            }
          });
          return;
        }

        if (request.type === "WATCH_CAPTURE_STEP") {
          const tabId = sender.tab?.id;
          if (typeof tabId !== "number") {
            sendResponse({
              ok: false,
              error: {
                code: "WATCH_TAB_REQUIRED",
                message:
                  "Recorded workflow steps must come from a browser tab"
              }
            });
            return;
          }

          const captured = await appendWatchStep(
            tabId,
            request.step
          );
          sendResponse({
            ok: Boolean(captured.session),
            data: {
              accepted: captured.accepted
            },
            ...(!captured.session
              ? {
                  error: {
                    code: "WATCH_NOT_RECORDING",
                    message:
                      "No active Watch Me recording session"
                  }
                }
              : {})
          });
          return;
        }

        if (request.type === "WATCH_STOP") {
          const active = await getWatchRecording();
          if (!active) {
            sendResponse({
              ok: false,
              error: {
                code: "WATCH_NOT_RECORDING",
                message: "No active Watch Me recording session"
              }
            });
            return;
          }

          for (const tabId of active.tab_ids) {
            const finalStep = await disarmWatchTab(tabId).catch(
              () => null
            );
            if (finalStep) {
              await appendWatchStep(tabId, finalStep);
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 25));

          const completed = await stopWatchRecording();
          if (!completed) {
            sendResponse({
              ok: false,
              error: {
                code: "WATCH_NOT_RECORDING",
                message:
                  "Watch Me recording ended before it could be saved"
              }
            });
            return;
          }

          const currentTab = await chrome.tabs
            .get(completed.current_tab_id)
            .catch(() => null);
          const apiCapture = await finishWatchApiCapture(completed.id, completed.start_url, completed.steps, completed.events);

          sendResponse({
            ok: true,
            data: {
              recording_active: false,
              recording_id: completed.id,
              started_at: completed.started_at,
              start_url: completed.start_url,
              end_url:
                currentTab?.url ||
                completed.steps.at(-1)?.url ||
                completed.start_url,
              steps: completed.steps,
              events: completed.events,
              boundary_step_id: completed.boundary_step_id,
              recording: watchRecordingSummary(completed),
              ...(apiCapture ? { api_capture: apiCapture } : {})
            }
          });
          return;
        }

        if (request.type === "WATCH_REPLAY_STEP") {
          const resolved = await targetTab(
            typeof request.tab_id === "number"
              ? { tab_id: request.tab_id }
              : {}
          );
          sendResponse(
            await sendToTab(resolved.tab.id!, {
              type: request.type,
              step: request.step
            })
          );
          return;
        }

        sendResponse({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Unknown request"
          }
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message:
              error instanceof Error
                ? error.message
                : "Unknown background error"
          }
        });
      }
    })();
    return true;
  }
);
