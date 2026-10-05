import { useEffect, useRef, useState } from "react";
import { autoApproves } from "../runtime/approval-mode";
import {
  APPROVAL_WORDS,
  approvalQuestionFor,
  extensionMessage,
  runAgentTask,
  safeHostname
} from "../runtime/agent-task";
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
  MemoryIcon,
  SettingsIcon,
  SkillsIcon,
  StopIcon
} from "./icons";
import { SkillsView } from "./SkillsView";
import { MemoryView } from "./MemoryView";
import {
  loadSkills,
  recordSkillRun,
  refreshSkillSteps,
  saveSkill,
  skillFromSession,
  skillTask,
  SKILLS_STORAGE_KEY,
  worthSaving,
  type UserSkill
} from "../runtime/skills";
import {
  BUILT_IN_COMMANDS,
  helpText,
  parseSlashCommand,
  slashSuggestions,
  type SlashCommand
} from "../runtime/slash-commands";
import {
  aboutMePrompt,
  addFacts,
  factsInMessage,
  forgetMatching,
  isStorableFact,
  loadAboutMe
} from "../runtime/about-me";
import type { BrowserTaskSessionEvidence } from "../runtime/session-evidence";
import {
  describeSchedule,
  newScheduledTask,
  parseScheduleText,
  saveScheduledTask
} from "../runtime/schedules";
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
import { directChatWithFallback } from "../runtime/model-router";
import { replaySavedWorkflowAdaptive } from "../runtime/workflow-adaptive-replay";
import type {
  AdaptiveReplayDependencies,
  AdaptiveReplayToolExecution
} from "../runtime/adaptive-replay";
import { classifyTaskIntent } from "../runtime/intent";
import type { ToolName } from "../runtime/protocol";
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
import { waitForUserAction } from "../runtime/user-handoff";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** What the agent did, so the task can be saved as (or improve) a Skill. */
  learned?: { evidence: BrowserTaskSessionEvidence; task: string; skillId?: string };
  /** Set once the person saved or updated a Skill from this answer. */
  skillNote?: string;
};

const RESERVED_COMMANDS = BUILT_IN_COMMANDS.map((command) => command.name);
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

export function App() {
  const [view, setView] = useState<
    "chat" | "settings" | "history" | "skills" | "memory"
  >(() => {
    // Notifications open the panel page with ?view=scheduled.
    const asked = new URLSearchParams(location.search).get("view");
    return asked === "scheduled" ? "history" : asked === "skills" || asked === "memory" || asked === "history" ? asked : "chat";
  });
  const [historyTab, setHistoryTab] = useState<"past" | "scheduled">(() =>
    new URLSearchParams(location.search).get("view") === "scheduled" ? "scheduled" : "past"
  );
  const [skills, setSkills] = useState<UserSkill[]>([]);
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

  const addAssistantMessage = (
    text: string,
    learned?: Message["learned"]
  ) => {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "assistant", text, learned }
    ]);
  };

  useEffect(() => {
    void loadSkills().then(setSkills).catch(() => undefined);
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && changes[SKILLS_STORAGE_KEY]) {
        void loadSkills().then(setSkills).catch(() => undefined);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const noteOnMessage = (id: string, skillNote: string) => {
    setMessages((items) =>
      items.map((item) => (item.id === id ? { ...item, skillNote } : item))
    );
  };

  const saveAsSkill = async (message: Message) => {
    if (!message.learned) return;
    const saved = await saveSkill(
      skillFromSession({
        ...message.learned.evidence,
        task: message.learned.task
      }),
      RESERVED_COMMANDS
    );
    noteOnMessage(
      message.id,
      `Saved as a Skill. Run it any time with /${saved.slug}, or from the Skills screen.`
    );
  };

  const updateSkillFromRun = async (message: Message) => {
    const learned = message.learned;
    if (!learned?.skillId) return;
    const skill = (await loadSkills()).find((item) => item.id === learned.skillId);
    if (!skill) {
      noteOnMessage(message.id, "That Skill was deleted.");
      return;
    }
    await saveSkill(refreshSkillSteps(skill, learned.evidence), RESERVED_COMMANDS);
    noteOnMessage(message.id, `Updated /${skill.slug} with the steps from this run.`);
  };

  const runCommand = async (command: SlashCommand, typed: string) => {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: typed }
    ]);
    if (command.kind === "unknown") {
      addAssistantMessage(
        `There's no command or Skill called /${command.name}. Type / to see them, or /help for the list.`
      );
      return;
    }
    if (command.kind !== "builtin") return;
    switch (command.name) {
      case "remember": {
        if (!command.args) {
          addAssistantMessage("Tell me what to remember, like `/remember I prefer aisle seats`.");
          return;
        }
        if (!isStorableFact(command.args)) {
          addAssistantMessage("That looks like a password, card or ID number, so I won't save it.");
          return;
        }
        const added = await addFacts([command.args], "you");
        addAssistantMessage(
          added.length
            ? `Got it. I'll remember: ${added[0].text}`
            : "I already know that."
        );
        return;
      }
      case "forget": {
        if (!command.args) {
          addAssistantMessage("Tell me what to forget, like `/forget aisle seats`, or open /memory.");
          return;
        }
        const removed = await forgetMatching(command.args);
        addAssistantMessage(
          removed
            ? `Forgot ${removed} fact${removed === 1 ? "" : "s"} about “${command.args}”.`
            : `I had nothing saved about “${command.args}”.`
        );
        return;
      }
      case "memory":
        setView("memory");
        return;
      case "skills":
        setView("skills");
        return;
      case "schedule": {
        if (!command.args) {
          setHistoryTab("scheduled");
          setView("history");
          return;
        }
        const parsed = parseScheduleText(command.args);
        if (!parsed) {
          addAssistantMessage(
            "I couldn't tell when to run it. Start with the time, like `/schedule every weekday at 8am check my inbox`, `/schedule every 2 hours …` or `/schedule tomorrow at 7am …`. You can also use History → Scheduled."
          );
          return;
        }
        if (!parsed.task) {
          addAssistantMessage("What should it do at that time? Add the task after the time.");
          return;
        }
        const item = newScheduledTask(parsed.task, parsed.schedule);
        if (!item.next_run_at) {
          addAssistantMessage("That time has already passed. Pick a time in the future.");
          return;
        }
        await saveScheduledTask(item);
        addAssistantMessage(
          `Scheduled: **${item.task}**\n\n${describeSchedule(item.schedule)}. Next run ${new Date(item.next_run_at).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" })}. It runs in its own background tab while Chrome is open, and anything that needs your approval waits for you. See it under History → Scheduled.`
        );
        return;
      }
      default:
        addAssistantMessage(helpText(await loadSkills()));
    }
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

  const runTask = async (textOverride?: string) => {
    const typed = (textOverride ?? prompt).trim();
    if (!typed || running) return;
    const attachmentNote = describeAttachmentsForPrompt(attachments);

    // Slash commands: built-ins answer right away; a Skill runs as a task.
    const command = parseSlashCommand(typed, await loadSkills().catch(() => []));
    if (command.kind === "builtin" || command.kind === "unknown") {
      setPrompt("");
      await runCommand(command, typed);
      return;
    }
    const skillRun = command.kind === "skill" ? command.skill : null;
    const task = skillRun ? skillTask(skillRun, command.kind === "skill" ? command.args : "") : typed;

    // A model the user picked from the model menu may not have been checked
    // yet: try it. Only send them to settings when nothing usable is chosen.
    if (!primary || !hasCredentials(primary) || !primary.model) {
      setView("settings");
      return;
    }

    setPrompt("");
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: typed }
    ]);
    setActivities([]);
    setRunning(true);
    setPaused(false);
    pausedRef.current = false;
    cancelled.current = false;

    // About me: pick up plain facts from the request, then share what is known.
    let aboutMe = "";
    try {
      const preferences = await loadPreferences();
      if (preferences.learnAboutMe && !skillRun) {
        const learned = await addFacts(factsInMessage(typed), "learned");
        if (learned.length) {
          addActivity(
            `Remembered about you: ${learned.map((fact) => fact.text).join("; ")}`,
            "done"
          );
        }
      }
      aboutMe = aboutMePrompt(await loadAboutMe());
    } catch {
      aboutMe = "";
    }

    const intent = skillRun ? "browser" : classifyTaskIntent(task);

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
            task + aboutMe,
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
          await saveHistory(typed, routed.result);
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
        typed.length > 48 ? `${typed.slice(0, 45)}…` : typed;

      const result = await runAgentTask(task + attachmentNote + aboutMe, {
        agentPrimary,
        agentFallback,
        session: { id: taskSessionId, title: taskSessionTitle },
        signal: controller.signal,
        hooks: {
          addActivity,
          finishActivity,
          isCancelled: () => cancelled.current,
          isPaused: () => pausedRef.current,
          approvalQuestion: (observation, tool, input) => {
            approvalHost.current = safeHostname(observation.url);
            return approvalQuestionFor(approvalMode.current, observation, tool, input);
          },
          requestApproval: async (description) => {
            const approved = await requestApproval(description);
            setApproval(null);
            return approved;
          },
          requestUserAction: async (reason, observation, handoffSignal) => {
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
          }
        }
      });
      requestAbort.current = null;
      const evidence = result.session_evidence;
      if (skillRun) {
        if (result.status === "completed") {
          await recordSkillRun(skillRun.id, "worked").catch(() => null);
          addAssistantMessage(result.message, {
            evidence,
            task: typed,
            skillId: skillRun.id
          });
        } else {
          if (!cancelled.current && result.status === "stopped") {
            await recordSkillRun(skillRun.id, "failed", result.message).catch(() => null);
          }
          addAssistantMessage(result.message);
        }
      } else {
        addAssistantMessage(
          result.message,
          result.status === "completed" && worthSaving(evidence)
            ? { evidence, task: typed }
            : undefined
        );
      }
      if (result.status === "completed") {
        await saveHistory(typed, result.message);
      }
      return;
    } catch (error) {
      if (skillRun && !cancelled.current) {
        // Counted, but a model or network error teaches nothing about the task.
        await recordSkillRun(skillRun.id, "failed").catch(() => null);
      }
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

  const commandSuggestions = slashSuggestions(prompt, skills);

  if (view === "skills") {
    return (
      <SkillsView
        onBack={() => setView("chat")}
        onRun={(skill) => {
          setView("chat");
          void runTask(`/${skill.slug}`);
        }}
        onReplay={(workflow) => {
          setView("chat");
          void replayWorkflow(workflow);
        }}
      />
    );
  }

  if (view === "memory") {
    return <MemoryView onBack={() => setView("chat")} />;
  }

  if (view === "history") {
    return (
      <HistoryView
        initialTab={historyTab}
        onBack={() => {
          setHistoryTab("past");
          setView("chat");
        }}
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
          <Tooltip title="Skills">
            <IconButton
              size="small"
              onClick={() => setView("skills")}
              aria-label="Skills"
            >
              <SkillsIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="About me">
            <IconButton
              size="small"
              onClick={() => setView("memory")}
              aria-label="About me"
            >
              <MemoryIcon />
            </IconButton>
          </Tooltip>
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
                      {message.learned && !message.skillNote && (
                        message.learned.skillId ? (
                          <Button
                            size="small"
                            onClick={() => void updateSkillFromRun(message)}
                            sx={{ mt: 0.5 }}
                          >
                            Update the Skill with this run
                          </Button>
                        ) : (
                          <Tooltip describeChild title="Teach BrowserHarness this task so it can repeat it with one command">
                            <Button
                              size="small"
                              startIcon={<SkillsIcon fontSize="small" />}
                              onClick={() => void saveAsSkill(message)}
                              sx={{ mt: 0.5 }}
                            >
                              Save as Skill
                            </Button>
                          </Tooltip>
                        )
                      )}
                      {message.skillNote && (
                        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                          {message.skillNote}
                        </Typography>
                      )}
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
        {commandSuggestions.length > 0 && (
          <Paper variant="outlined" sx={{ mb: 0.5, maxHeight: 220, overflowY: "auto" }} role="listbox" aria-label="Commands">
            {commandSuggestions.map((command) => (
              <Box
                key={command.name}
                role="option"
                aria-selected={false}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setPrompt(`/${command.name} `);
                }}
                sx={{ px: 1.5, py: 0.75, cursor: "pointer", "&:hover": { bgcolor: "action.hover" } }}
              >
                <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                  /{command.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                  {command.description}
                </Typography>
              </Box>
            ))}
          </Paper>
        )}
        <TextField
          multiline
          maxRows={5}
          fullWidth
          placeholder="Ask BrowserHarness… (type / for commands)"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Tab" && commandSuggestions.length > 0) {
              event.preventDefault();
              setPrompt(`/${commandSuggestions[0].name} `);
              return;
            }
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
