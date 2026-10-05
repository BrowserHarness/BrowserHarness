import { useEffect, useRef, useState } from "react";
import { approvalFor, autoApproves } from "../runtime/approval-mode";
import { dictationAvailable, speak, startDictation } from "./voice";
import { downloadCsv, markdownTables } from "./table-csv";
import {
  loadPreferences,
  PREFERENCES_STORAGE_KEY,
  type ApprovalMode,
  type UserPreferences
} from "../settings/preferences";
import {
  AddIcon,
  HistoryIcon,
  DownloadIcon,
  MicIcon,
  SpeakIcon,
  PauseIcon,
  PolishIcon,
  RecordIcon,
  ReplayIcon,
  SendIcon,
  SettingsIcon,
  StopIcon
} from "./icons";
import {
  addGrant,
  isGrantableHost,
  isHostGranted,
  loadSiteGrants,
  normalizeGrantHost,
  saveSiteGrants,
  type SiteGrant
} from "../settings/site-grants";
import { Markdown } from "./Markdown";
import {
  renderIntentPrompt,
  workflowToIntentSkill
} from "../runtime/intent-skill";
import {
  deleteAttachment,
  describeAttachmentsForPrompt,
  fileToBase64,
  listAttachments,
  saveAttachment,
  toMeta,
  type AttachmentMeta
} from "../runtime/attachments";
import {
  QUICK_EXPLAIN_STORAGE_KEY,
  buildExplainPrompt,
  parsePendingExplain
} from "../runtime/quick-explain";
import {
  buildPolishPrompt,
  cleanPolishedPrompt
} from "../runtime/prompt-polish";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from "@mui/material";
import {
  hasCredentials,
  loadActiveConnection,
  loadFallbackConnection,
  type ProviderConnection
} from "../settings/provider-store";
import {
  directChatWithFallback,
  agentDecisionWithFallback,
  readOnlyWorkerDecisionWithFallback
} from "../runtime/model-router";
import {
  runBrowserTask,
  type BrowserToolExecution
} from "../runtime/browser-engine";
import { replaySavedWorkflowAdaptive } from "../runtime/workflow-adaptive-replay";
import type {
  AdaptiveReplayDependencies,
  AdaptiveReplayToolExecution
} from "../runtime/adaptive-replay";
import { classifyTaskIntent } from "../runtime/intent";
import type { PageObservation, ToolName, ToolResult } from "../runtime/protocol";
import {
  finalizeRecordedSteps,
  inferWorkflowInputs,
  saveWorkflow,
  type RecordedWorkflowStep,
  type SavedWorkflow,
  type WorkflowRecordingEvent,
  type WorkflowRecordingSummary
} from "../runtime/workflows";
import { SettingsView } from "./SettingsView";
import { ModelMenu } from "./ModelMenu";
import { HistoryView } from "./HistoryView";
import { saveTaskHistoryEntry } from "../runtime/history";
import {
  saveTaskEpisodeMemory
} from "../runtime/task-memory";
import {
  indexTaskEpisodeMemory,
  searchTaskMemoryHybrid
} from "../runtime/semantic-memory";
import {
  searchProceduralMemory
} from "../runtime/procedural-memory";
import {
  discoverMcpCatalog as buildMcpCatalog
} from "../runtime/mcp-catalog";
import {
  getMcpServerTrustMode
} from "../settings/mcp-trust-store";
import {
  clearBrowserWorkingMemory,
  saveBrowserWorkingMemory
} from "../runtime/working-memory";
import { waitForUserAction } from "../runtime/user-handoff";
import {
  runReadOnlySubagent
} from "../runtime/subagent-runner";
import {
  buildDagWorkerTask,
  parseTaskDag,
  runTaskDag
} from "../runtime/task-dag";
import {
  parseReadOnlySubagentTasks,
  runReadOnlySubagentBatch
} from "../runtime/subagent-supervisor";

type Message = { id: string; role: "user" | "assistant"; text: string };
type Activity = { id: string; text: string; state: "working" | "done" | "error" };
type CurrentTab = { tab_id: number; title?: string; url?: string };
type Approval = {
  description: string;
  host: string;
  resolve: (approved: boolean) => void;
};
type Handoff = {
  reason: string;
  resolve: (status: "continue" | "cancelled") => void;
};

const APPROVAL_WORDS =
  /\b(send|submit|publish|buy|purchase|checkout|place order|pay|delete|remove|change password|security)\b/i;

async function extensionMessage<T>(request: unknown): Promise<ToolResult<T>> {
  return chrome.runtime.sendMessage(request);
}

function safeHostname(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function approvalDescription(
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

export function App() {
  const [view, setView] = useState<"chat" | "settings" | "history">("chat");
  const [tab, setTab] = useState<CurrentTab | null>(null);
  const [primary, setPrimary] = useState<ProviderConnection | null>(null);
  const [fallback, setFallback] = useState<ProviderConnection | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [lastWorkflow, setLastWorkflow] = useState<SavedWorkflow | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const cancelled = useRef(false);
  const pausedRef = useRef(false);
  const requestAbort = useRef<AbortController | null>(null);

  const refreshContext = async () => {
    const [
      currentTab,
      primaryConnection,
      fallbackConnection,
      watchStatus
    ] = await Promise.all([
      extensionMessage<CurrentTab>({ type: "GET_CURRENT_TAB" }),
      loadActiveConnection(),
      loadFallbackConnection(),
      extensionMessage<{ recording: boolean }>({
        type: "WATCH_STATUS"
      })
    ]);
    if (currentTab.ok && currentTab.data) setTab(currentTab.data);
    if (watchStatus.ok && watchStatus.data) {
      setRecording(Boolean(watchStatus.data.recording));
    }
    setPrimary(primaryConnection);
    setFallback(fallbackConnection);
  };

  useEffect(() => {
    void refreshContext();
  }, [view]);

  useEffect(() => {
    const consume = async () => {
      try {
        const stored = await chrome.storage.session.get(
          QUICK_EXPLAIN_STORAGE_KEY
        );
        const pending = parsePendingExplain(
          stored[QUICK_EXPLAIN_STORAGE_KEY]
        );
        if (!pending) return;
        await chrome.storage.session.remove(
          QUICK_EXPLAIN_STORAGE_KEY
        );
        setView("chat");
        setPrompt(buildExplainPrompt(pending.text, pending.url));
      } catch {
        // Session storage unavailable; quick-explain is a convenience only.
      }
    };
    void consume();
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "session" && QUICK_EXPLAIN_STORAGE_KEY in changes) {
        void consume();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const addAssistantMessage = (text: string) => {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "assistant", text }
    ]);
  };

  const addActivity = (text: string, state: Activity["state"] = "working") => {
    const id = crypto.randomUUID();
    setActivities((items) => [...items.slice(-6), { id, text, state }]);
    return id;
  };

  const finishActivity = (id: string, state: Activity["state"] = "done") => {
    setActivities((items) =>
      items.map((item) => (item.id === id ? { ...item, state } : item))
    );
  };

  const approvalHost = useRef("");
  const siteGrants = useRef<SiteGrant[]>([]);
  useEffect(() => {
    void loadSiteGrants()
      .then((items) => {
        siteGrants.current = items;
      })
      .catch(() => undefined);
  }, []);

  const approvalMode = useRef<ApprovalMode>("risky");
  useEffect(() => {
    void loadPreferences()
      .then((preferences) => {
        approvalMode.current = preferences.approvalMode;
      })
      .catch(() => undefined);
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      const next = changes[PREFERENCES_STORAGE_KEY]?.newValue as UserPreferences | undefined;
      if (area === "local" && next?.approvalMode) approvalMode.current = next.approvalMode;
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const requestApproval = async (
    description: string,
    hostOverride?: string
  ) => {
    if (autoApproves(approvalMode.current, description)) {
      addActivity(`Approved automatically (automatic mode): ${description}`, "done");
      return true;
    }
    const host =
      hostOverride ?? (approvalHost.current || safeHostname(tab?.url));
    if (host && isHostGranted(siteGrants.current, host)) {
      addActivity(`Approved automatically (always allowed on ${host})`, "done");
      return true;
    }
    return new Promise<boolean>((resolve) =>
      setApproval({ description, host, resolve })
    );
  };

  const grantSite = async (host: string) => {
    const next = addGrant(siteGrants.current, host);
    siteGrants.current = next;
    await saveSiteGrants(next).catch(() => undefined);
  };

  const showHandoffPrompt = (reason: string) =>
    new Promise<"continue" | "cancelled">((resolve) => {
      setHandoff({ reason, resolve });
    });

  const [listening, setListening] = useState(false);
  const stopListening = useRef<(() => void) | null>(null);
  const handleDictate = () => {
    if (listening) {
      stopListening.current?.();
      return;
    }
    const before = prompt.trim();
    setListening(true);
    stopListening.current = startDictation({
      onText: (text) => setPrompt(before ? `${before} ${text}` : text),
      onEnd: () => {
        setListening(false);
        stopListening.current = null;
      },
      onError: (error) => {
        if (error === "not-allowed" || error === "service-not-allowed") {
          void chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
          addAssistantMessage(
            "Allow the microphone in the tab I opened, then press the microphone button again."
          );
        } else if (error === "unsupported") {
          addAssistantMessage("Speech input is not available in this browser.");
        } else if (error !== "no-speech" && error !== "aborted") {
          addAssistantMessage(`Speech input stopped: ${error}.`);
        }
      }
    });
  };

  const handleRecord = async () => {
    if (!tab?.tab_id) {
      addAssistantMessage("Open a normal webpage before recording a workflow.");
      return;
    }

    if (!recording) {
      const result = await extensionMessage<{ recording: boolean }>({
        type: "WATCH_START",
        tab_id: tab.tab_id
      });
      if (!result.ok) {
        addAssistantMessage(result.error?.message || "I couldn't start recording on this page.");
        return;
      }
      setRecording(true);
      addAssistantMessage(
        "Recording across pages and tabs. Show BrowserHarness the workflow you want it to learn; navigation, new tabs, clicks, text entry, Enter and Tab are captured. Password fields are never recorded."
      );
      return;
    }

    const result = await extensionMessage<{
      steps: RecordedWorkflowStep[];
      events: WorkflowRecordingEvent[];
      boundary_step_id?: string;
      recording: WorkflowRecordingSummary;
      start_url: string;
      end_url: string;
    }>({
      type: "WATCH_STOP"
    });
    setRecording(false);
    if (!result.ok || !result.data) {
      addAssistantMessage(result.error?.message || "I couldn't finish this recording.");
      return;
    }

    const steps = finalizeRecordedSteps(result.data.steps);
    if (steps.length === 0) {
      addAssistantMessage("Recording stopped. I didn't capture any reusable actions.");
      return;
    }

    const workflow: SavedWorkflow = {
      id: crypto.randomUUID(),
      version: 3,
      name: `Workflow ${new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })}`,
      created_at: new Date().toISOString(),
      url: result.data.start_url || tab.url || "",
      end_url:
        result.data.end_url ||
        steps.at(-1)?.url ||
        tab.url ||
        "",
      inputs: inferWorkflowInputs(steps),
      steps,
      events: result.data.events,
      boundary_step_id: result.data.boundary_step_id,
      recording: result.data.recording
    };
    await saveWorkflow(workflow);
    setLastWorkflow(workflow);
    addAssistantMessage(
      `Saved “${workflow.name}” with ${steps.length} action step${steps.length === 1 ? "" : "s"}, ${workflow.events?.length || 0} browser-context event${workflow.events?.length === 1 ? "" : "s"}, and ${workflow.inputs?.length || 0} reusable input${workflow.inputs?.length === 1 ? "" : "s"} across ${workflow.recording?.tab_count || 1} tab${workflow.recording?.tab_count === 1 ? "" : "s"}.${(workflow.recording?.dropped_steps || workflow.recording?.dropped_events) ? " Recording limits dropped some excess evidence." : ""}`
    );
  };

  const replayWorkflow = async (workflow: SavedWorkflow) => {
    if (!tab?.tab_id) return;

    if (workflow.version === 3) {
      setRunning(true);
      cancelled.current = false;
      setActivities([]);

      const activity = addActivity(
        `Adaptive replay: ${workflow.name}`
      );
      const taskSessionId = crypto.randomUUID();
      const taskSessionTitle =
        workflow.name.length > 48
          ? `${workflow.name.slice(0, 45)}…`
          : workflow.name;

      try {
        const dependencies: AdaptiveReplayDependencies = {
          tool: <T = unknown>(
            tool: ToolName,
            input: Record<string, unknown> = {},
            execution?: AdaptiveReplayToolExecution
          ) =>
            extensionMessage<T>({
              type: "BROWSER_TOOL",
              tool,
              input,
              session_id: taskSessionId,
              session_title: taskSessionTitle,
              approval_granted: execution?.approvalGranted
            }),
          requestApproval: async (description) => {
            const approved = await requestApproval(description);
            setApproval(null);
            return approved;
          },
          isCancelled: () => cancelled.current
        };

        const result = await replaySavedWorkflowAdaptive(
          workflow,
          dependencies
        );

        if (result.status === "completed") {
          finishActivity(activity, "done");
          addAssistantMessage(
            `Finished adaptive replaying “${workflow.name}” through the demonstrated boundary.`
          );
        } else if (result.status === "approval-cancelled") {
          finishActivity(activity, "done");
          addAssistantMessage(
            "Workflow replay stopped before the unapproved action."
          );
        } else {
          finishActivity(activity, "done");
          addAssistantMessage("Workflow replay stopped.");
        }
      } catch (error) {
        finishActivity(activity, "error");
        addAssistantMessage(
          error instanceof Error
            ? error.message
            : "Adaptive workflow replay failed."
        );
      } finally {
        setApproval(null);
        setRunning(false);
        cancelled.current = false;
      }
      return;
    }

    if ((workflow.recording?.tab_count || 1) > 1) {
      addAssistantMessage(
        `“${workflow.name}” is a multi-tab Watch Me v2 recording. Its full browser-context evidence is preserved for adaptive replay / Skill compilation; the legacy exact-step replay button is intentionally limited to single-tab workflows.`
      );
      return;
    }
    const recordedHost = safeHostname(workflow.url);
    const currentHost = safeHostname(tab.url);
    if (recordedHost && currentHost && recordedHost !== currentHost) {
      addAssistantMessage(
        `Open ${recordedHost} before replaying “${workflow.name}”. The v0.1 recorder is intentionally site-scoped.`
      );
      return;
    }

    setRunning(true);
    cancelled.current = false;
    setActivities([]);

    try {
      for (const step of workflow.steps) {
        if (cancelled.current) break;

        if (
          step.action === "click" &&
          (step.locator.requires_approval ||
            APPROVAL_WORDS.test(step.locator.accessible_name))
        ) {
          const approved = await requestApproval(
            `Replay “${step.locator.accessible_name || "this action"}” on ${currentHost || "this page"}`,
            currentHost || ""
          );
          setApproval(null);
          if (!approved) {
            addAssistantMessage(
              "Workflow replay stopped before that action."
            );
            return;
          }
        }

        if (
          step.action === "key" &&
          step.key.toLowerCase() === "enter" &&
          step.locator?.enter_requires_approval
        ) {
          const approved = await requestApproval(
            `Replay Enter in “${step.locator.accessible_name || step.locator.role}” on ${currentHost || "this page"}; this may submit a form`,
            currentHost || ""
          );
          setApproval(null);
          if (!approved) {
            addAssistantMessage(
              "Workflow replay stopped before that submission."
            );
            return;
          }
        }

        const activity = addActivity(
          step.action === "click"
            ? `Replaying click: ${step.locator.accessible_name || step.locator.role}`
            : step.action === "type"
              ? `Replaying text entry: ${step.locator.accessible_name || step.locator.role}`
              : `Replaying key: ${step.key}${
                  step.locator
                    ? ` in ${step.locator?.accessible_name || step.locator?.role || "the recorded field"}`
                    : ""
                }`
        );

        const result = await extensionMessage({
          type: "WATCH_REPLAY_STEP",
          tab_id: tab.tab_id,
          step
        });
        finishActivity(activity, result.ok ? "done" : "error");
        if (!result.ok) {
          throw new Error(result.error?.message || "Workflow replay failed");
        }

        await extensionMessage({
          type: "BROWSER_TOOL",
          tool: "wait",
          input: { milliseconds: 350 }
        });
      }

      if (cancelled.current) {
        addAssistantMessage("Workflow replay stopped.");
      } else {
        addAssistantMessage(`Finished replaying “${workflow.name}”.`);
      }
    } catch (error) {
      addAssistantMessage(
        error instanceof Error ? error.message : "Workflow replay failed."
      );
    } finally {
      setRunning(false);
      cancelled.current = false;
    }
  };

  useEffect(() => {
    void listAttachments()
      .then((items) => setAttachments(items.map(toMeta)))
      .catch(() => undefined);
  }, []);

  const handleAttach = async (files: FileList | null) => {
    for (const file of Array.from(files || [])) {
      try {
        const record = await saveAttachment({
          name: file.name,
          mime: file.type,
          size: file.size,
          data_b64: await fileToBase64(file)
        });
        setAttachments((items) => [...items, toMeta(record)]);
      } catch (error) {
        addAssistantMessage(
          error instanceof Error
            ? error.message.replace(/^[A-Z_]+: /, "")
            : "Could not attach that file."
        );
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const [polishing, setPolishing] = useState(false);
  const handlePolish = async () => {
    const draft = prompt.trim();
    if (!draft || polishing || !primary) return;
    setPolishing(true);
    try {
      const routed = await directChatWithFallback(
        primary,
        fallback?.chatHealth.status === "healthy" ? fallback : null,
        buildPolishPrompt(draft)
      );
      setPrompt(cleanPolishedPrompt(routed.result, draft));
    } catch {
      addAssistantMessage("Could not polish that request right now.");
    } finally {
      setPolishing(false);
    }
  };

  const removeAttachment = async (id: string) => {
    await deleteAttachment(id).catch(() => undefined);
    setAttachments((items) => items.filter((item) => item.id !== id));
  };

  const runTask = async () => {
    const task = prompt.trim();
    if (!task || running) return;
    const attachmentNote = describeAttachmentsForPrompt(attachments);

    // A model the user picked from the model menu may not have been checked
    // yet: try it. Only send them to settings when nothing usable is chosen.
    if (!primary || !hasCredentials(primary) || !primary.model) {
      setView("settings");
      return;
    }

    setPrompt("");
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: task }
    ]);
    setActivities([]);
    setRunning(true);
    setPaused(false);
    pausedRef.current = false;
    cancelled.current = false;

    const intent = classifyTaskIntent(task);

    try {
      if (intent === "chat") {
        const activity = addActivity("Thinking");
        const controller = new AbortController();
        requestAbort.current = controller;

        try {
          const routed = await directChatWithFallback(
            primary,
            fallback?.chatHealth.status === "healthy"
              ? fallback
              : null,
            task,
            controller.signal
          );

          finishActivity(activity);
          if (routed.usedFallback) {
            const fallbackActivity = addActivity(
              "Primary unavailable — used fallback model",
              "done"
            );
            finishActivity(fallbackActivity);
          }

          addAssistantMessage(routed.result);
          await saveHistory(task, routed.result);
          return;
        } catch (error) {
          finishActivity(activity, cancelled.current ? "done" : "error");
          throw error;
        } finally {
          requestAbort.current = null;
        }
      }

      const agentPrimary =
        primary.agentHealth.status !== "failed"
          ? primary
          : fallback?.agentHealth.status === "healthy"
            ? fallback
            : null;

      if (!agentPrimary) {
        throw new Error(
          `${primary.model} did not pass the browser-control check. Pick another model from the model menu at the top.`
        );
      }

      const agentFallback =
        agentPrimary.id === primary.id &&
        fallback?.agentHealth.status === "healthy"
          ? fallback
          : null;

      const controller = new AbortController();
      requestAbort.current = controller;
      const taskSessionId = crypto.randomUUID();
      const taskSessionTitle =
        task.length > 48 ? `${task.slice(0, 45)}…` : task;

      const result = await runBrowserTask(
        task + attachmentNote,
        {
          session: {
            id: taskSessionId,
            title: taskSessionTitle
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
              browserTask,
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
              const launchWorker = async (spec: { task: string; max_steps: number }, index: number) => {
                    const workerTask = spec.task;
                    const workerSessionId =
                      `${taskSessionId}:worker:${index + 1}:${crypto.randomUUID()}`;
                    const workerSessionTitle =
                      workerTask.length > 48
                        ? `Worker ${index + 1}: ${workerTask.slice(0, 37)}…`
                        : `Worker ${index + 1}: ${workerTask}`;

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
                              mcp_catalog
                            );
                          return {
                            decision: routed.result,
                            usedFallback:
                              routed.usedFallback
                          };
                        },
                        baseTool: (
                          workerTool,
                          workerInput = {}
                        ) =>
                          extensionMessage({
                            type: "BROWSER_TOOL",
                            tool: workerTool,
                            input: workerInput,
                            session_id:
                              workerSessionId,
                            session_title:
                              workerSessionTitle
                          }),
                        recallMemory: async (
                          subtask,
                          observation
                        ) =>
                          (
                            await searchTaskMemoryHybrid(
                              `${subtask} ${safeHostname(observation.url)}`,
                              3
                            )
                          ).map(
                            (hit) => hit.episode
                          ),
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
                          cancelled.current,
                        waitWhilePaused: async () => {
                          while (
                            pausedRef.current &&
                            !cancelled.current
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
                          addActivity(
                            `Worker ${index + 1} used fallback model`,
                            "done"
                          );
                        }
                      },
                      controller.signal,
                      spec.max_steps
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
                  controller.signal
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
                  controller.signal
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
              session_id: taskSessionId,
              session_title: taskSessionTitle,
              approval_granted: execution?.approvalGranted
            });
          },
          approvalDescription: (observation, tool, input) => {
            approvalHost.current = safeHostname(observation.url);
            return approvalFor(
              approvalMode.current,
              approvalDescription(observation, tool, input),
              observation,
              tool,
              input
            );
          },
          requestApproval: async (description) => {
            const approved = await requestApproval(description);
            setApproval(null);
            return approved;
          },
          persistWorkingMemory: (memory) =>
            saveBrowserWorkingMemory(memory),
          recallMemory: async (
            browserTask,
            observation
          ) =>
            (
              await searchTaskMemoryHybrid(
                `${browserTask} ${safeHostname(observation.url)}`,
                3
              )
            ).map((hit) => hit.episode),
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
          requestUserAction: async (
            reason,
            observation,
            handoffSignal
          ) => {
            try {
              return await waitForUserAction({
                tab_id: observation.tab_id,
                starting_url: observation.url,
                reason,
                signal: handoffSignal,
                prompt: showHandoffPrompt
              });
            } finally {
              setHandoff(null);
            }
          },
          isCancelled: () => cancelled.current,
          waitWhilePaused: async () => {
            while (pausedRef.current && !cancelled.current) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, 150)
              );
            }
          },
          withActivity: async (label, operation) => {
            const id = addActivity(label);
            try {
              const value = await operation();
              finishActivity(id);
              return value;
            } catch (error) {
              finishActivity(
                id,
                cancelled.current ? "done" : "error"
              );
              throw error;
            }
          },
          onFallback: () => {
            addActivity(
              "Primary unavailable — used fallback model",
              "done"
            );
          }
        },
        controller.signal
      );

      requestAbort.current = null;
      await saveTaskEpisodeMemory(
        result.session_evidence
      )
        .then(async (episode) => {
          await indexTaskEpisodeMemory(episode).catch(
            () => null
          );
          await clearBrowserWorkingMemory(taskSessionId);
        })
        .catch(() => undefined);
      addAssistantMessage(result.message);
      if (result.status === "completed") {
        await saveHistory(task, result.message);
      }
      return;
    } catch (error) {
      if (cancelled.current) {
        addAssistantMessage("Stopped.");
      } else if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        addAssistantMessage(
          "The model request was interrupted unexpectedly. Please try again."
        );
      } else {
        addAssistantMessage(
          error instanceof Error
            ? error.message
            : "BrowserHarness hit an unexpected error."
        );
      }
    } finally {
      requestAbort.current = null;
      setRunning(false);
      setPaused(false);
      pausedRef.current = false;
      cancelled.current = false;
    }
  };

  const saveHistory = async (task: string, result: string) => {
    await saveTaskHistoryEntry({
      task,
      result,
      url: tab?.url
    });
  };

  const handleStop = () => {
    cancelled.current = true;
    if (handoff) {
      handoff.resolve("cancelled");
      setHandoff(null);
    }
    requestAbort.current?.abort();
    requestAbort.current = null;
    pausedRef.current = false;
    setPaused(false);
    if (approval) {
      approval.resolve(false);
      setApproval(null);
    }
    // A page that never answers (for example one showing an alert) must not
    // leave the panel spinning: Stop always frees it right away.
    setActivities((items) =>
      items.map((item) =>
        item.state === "working" ? { ...item, state: "done" } : item
      )
    );
    setRunning(false);
  };

  if (view === "settings") {
    return <SettingsView onBack={() => setView("chat")} />;
  }

  if (view === "history") {
    return (
      <HistoryView
        onBack={() => setView("chat")}
        onRunAgain={(task) => {
          setPrompt(task);
          setView("chat");
        }}
      />
    );
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default"
      }}
    >
      <AppBar
        position="sticky"
        color="transparent"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          backdropFilter: "blur(12px)"
        }}
      >
        <Toolbar variant="dense" sx={{ minHeight: 56, gap: 1 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>
              BrowserHarness
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {safeHostname(tab?.url) || "No supported tab"}
            </Typography>
          </Box>

          {running && (
            <Tooltip title="Stop current task">
              <IconButton
                size="small"
                color="error"
                onClick={handleStop}
                aria-label="Stop current task"
              >
                <StopIcon />
              </IconButton>
            </Tooltip>
          )}
          <ModelMenu
            current={primary}
            onChanged={refreshContext}
            onManage={() => setView("settings")}
          />
          <Tooltip title="Task history">
            <IconButton
              size="small"
              onClick={() => setView("history")}
              aria-label="Task history"
            >
              <HistoryIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Settings">
            <IconButton
              size="small"
              onClick={() => setView("settings")}
              aria-label="Settings"
            >
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ px: 2, pt: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ overflowX: "auto", pb: 0.5 }}>
          <Chip size="small" label="Personal" variant="outlined" />
          <Chip
            size="small"
            label={tab?.title || "Current tab"}
            variant="outlined"
          />
          {recording && (
            <Chip
              size="small"
              color="error"
              label="Recording"
              icon={<RecordIcon />}
            />
          )}
        </Stack>
      </Box>

      <Box sx={{ flex: 1, p: 2, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={2}
            sx={{ minHeight: 300, textAlign: "center" }}
          >
            <Typography variant="h5">Give your browser a task.</Typography>
            <Typography color="text.secondary" sx={{ maxWidth: 300 }}>
              Ask BrowserHarness to read, navigate, compare, fill, or work across tabs.
            </Typography>
            {!primary && (
              <Button variant="contained" onClick={() => setView("settings")}>
                Connect your AI
              </Button>
            )}
            <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="center">
              {["Summarize this page", "Find the best option", "Fill this form"].map(
                (suggestion) => (
                  <Chip
                    key={suggestion}
                    label={suggestion}
                    onClick={() => setPrompt(suggestion)}
                  />
                )
              )}
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={2}>
            {messages.map((message) => (
              <Box
                key={message.id}
                sx={{
                  alignSelf: message.role === "user" ? "flex-end" : "stretch",
                  maxWidth: message.role === "user" ? "88%" : "100%"
                }}
              >
                <Paper
                  variant={message.role === "user" ? "outlined" : "elevation"}
                  elevation={0}
                  sx={{
                    p: 1.5,
                    bgcolor:
                      message.role === "user" ? "action.hover" : "transparent"
                  }}
                >
                  {message.role === "assistant" ? (
                    <>
                      <Markdown text={message.text} />
                      {markdownTables(message.text).map((table, index, all) => (
                        <Button
                          key={index}
                          size="small"
                          startIcon={<DownloadIcon fontSize="small" />}
                          onClick={() =>
                            downloadCsv(table, `browserharness-table${all.length > 1 ? `-${index + 1}` : ""}.csv`)
                          }
                          sx={{ mt: 0.5, mr: 1 }}
                        >
                          {all.length > 1 ? `Download table ${index + 1} (CSV)` : "Download CSV"}
                        </Button>
                      ))}
                      <Tooltip title="Read aloud">
                        <IconButton
                          size="small"
                          aria-label="Read aloud"
                          onClick={() => speak(message.text)}
                          sx={{ mt: 0.5, opacity: 0.6 }}
                        >
                          <SpeakIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </>
                  ) : (
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                      {message.text}
                    </Typography>
                  )}
                </Paper>
              </Box>
            ))}

            {lastWorkflow && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<ReplayIcon />}
                onClick={() => void replayWorkflow(lastWorkflow)}
                disabled={running || recording}
                sx={{ alignSelf: "flex-start" }}
              >
                Replay {lastWorkflow.name}
              </Button>
            )}
            {lastWorkflow && (
              <Button
                variant="text"
                size="small"
                onClick={() =>
                  setPrompt(
                    renderIntentPrompt(
                      workflowToIntentSkill(lastWorkflow)
                    )
                  )
                }
                disabled={running || recording}
                sx={{ alignSelf: "flex-start" }}
              >
                Edit as intent skill
              </Button>
            )}

            {activities.length > 0 && (
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Agent activity
                </Typography>
                <Stack spacing={0.75} mt={1}>
                  {activities.map((activity) => (
                    <Stack
                      key={activity.id}
                      direction="row"
                      spacing={1}
                      alignItems="center"
                    >
                      {activity.state === "working" ? (
                        <CircularProgress size={13} />
                      ) : (
                        <Box component="span">
                          {activity.state === "done" ? "✓" : "!"}
                        </Box>
                      )}
                      <Typography variant="body2">{activity.text}</Typography>
                    </Stack>
                  ))}
                </Stack>
              </Paper>
            )}

            {approval && (
              <Alert
                severity="warning"
                action={
                  <Stack direction="row" spacing={0.5}>
                    <Button size="small" onClick={() => approval.resolve(false)}>
                      Cancel
                    </Button>
                    {isGrantableHost(normalizeGrantHost(approval.host)) && (
                      <Button
                        size="small"
                        onClick={() => {
                          void grantSite(approval.host);
                          approval.resolve(true);
                        }}
                      >
                        Always allow on this site
                      </Button>
                    )}
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => approval.resolve(true)}
                    >
                      Approve
                    </Button>
                  </Stack>
                }
              >
                BrowserHarness wants to: {approval.description}
              </Alert>
            )}

            {handoff && (
              <Alert
                severity="info"
                action={
                  <Stack direction="row" spacing={0.5}>
                    <Button
                      size="small"
                      onClick={() => handoff.resolve("cancelled")}
                    >
                      Cancel task
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => handoff.resolve("continue")}
                    >
                      I’m done, continue
                    </Button>
                  </Stack>
                }
              >
                <Typography variant="subtitle2">
                  Need you to take over
                </Typography>
                <Typography variant="body2">
                  {handoff.reason} Complete it on the page, then come back here.
                </Typography>
              </Alert>
            )}
          </Stack>
        )}
      </Box>

      <Divider />
      <Box sx={{ p: 1.5 }}>
        {running && (
          <Stack direction="row" spacing={1} mb={1}>
            <Button
              size="small"
              startIcon={<PauseIcon />}
              onClick={() =>
                setPaused((value) => {
                  const next = !value;
                  pausedRef.current = next;
                  return next;
                })
              }
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="small"
              color="error"
              startIcon={<StopIcon />}
              onClick={handleStop}
            >
              Stop
            </Button>
          </Stack>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="attach-input"
          onChange={(event) => void handleAttach(event.target.files)}
        />
        {attachments.length > 0 && (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", mb: 0.5 }}>
            {attachments.map((item) => (
              <Chip
                key={item.id}
                size="small"
                label={item.name}
                onDelete={() => void removeAttachment(item.id)}
              />
            ))}
          </Stack>
        )}
        <TextField
          multiline
          maxRows={5}
          fullWidth
          placeholder="Ask BrowserHarness…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void runTask();
            }
          }}
          slotProps={{
            input: {
              endAdornment: (
                <Stack direction="row" alignItems="center">
                  <Tooltip title="Attach files for uploads (up to 5 MB each)">
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => fileInput.current?.click()}
                        disabled={running}
                        aria-label="Attach files"
                      >
                        <AddIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Polish my request">
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => void handlePolish()}
                        disabled={!prompt.trim() || running || polishing}
                        aria-label="Polish request"
                      >
                        <PolishIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  {dictationAvailable() && (
                    <Tooltip title={listening ? "Stop listening" : "Speak your request"}>
                      <span>
                        <IconButton
                          size="small"
                          color={listening ? "error" : "default"}
                          onClick={handleDictate}
                          disabled={running}
                          aria-label={listening ? "Stop listening" : "Speak your request"}
                        >
                          <MicIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip
                    title={recording ? "Finish teaching" : "Watch Me & Learn"}
                  >
                    <IconButton
                      size="small"
                      color={recording ? "error" : "default"}
                      onClick={() => void handleRecord()}
                      disabled={running}
                      aria-label={recording ? "Finish recording" : "Record workflow"}
                    >
                      <RecordIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <IconButton
                    size="small"
                    color="primary"
                    onClick={() => void runTask()}
                    disabled={!prompt.trim() || running || recording}
                    aria-label="Send"
                  >
                    <SendIcon />
                  </IconButton>
                </Stack>
              )
            }
          }}
        />
      </Box>
    </Box>
  );
}
