import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Sidebar, type SidebarScreen } from "./Sidebar";
import { SpaceBadge, saveTextFile, useSpaces } from "./spaces-ui";
import {
  chatContextPrompt,
  chatFileName,
  chatTitle,
  chatToMarkdown,
  chatToText,
  getChat,
  saveChatMessages,
  type ChatMessage,
  type SavedChat
} from "../runtime/chats";
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
  CopyIcon,
  DownloadIcon,
  FullPageIcon,
  MenuIcon,
  NewChatIcon,
  SaveFileIcon,
  MicIcon,
  SpeakIcon,
  PauseIcon,
  PolishIcon,
  RecordIcon,
  ReplayIcon,
  SendIcon,
  SettingsIcon,
  SkillsIcon,
  StopIcon,
  RunIcon,
  WarningIcon,
  YesIcon
} from "./icons";
import { ProblemCard, useSaved } from "./feedback";
import { PolishDialog } from "./PolishDialog";
import { cantUseBrowser, diagnoseAi, type Problem } from "../help/problems";
import { aiContext } from "./settings/connect-ai";
import { SkillsView } from "./SkillsView";
import {
  loadSiteCommands,
  parseCommandArgs,
  recipeParameters,
  SITE_COMMAND_NAMES_KEY,
  type SiteCommand
} from "../runtime/site-commands";
import { SITE_SKILL_LIBRARY_KEY } from "../runtime/site-skill-store";
import { siteCommandAnswer } from "./site-command-answer";
import { applyLearningPlan, matchSkill, planLearning, skillHint } from "../runtime/skill-learning";
import { MemoryView } from "./MemoryView";
import {
  deleteSkill,
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
  factExtractionPrompt,
  factsInMessage,
  forgetMatching,
  isStorableFact,
  loadAboutMe,
  mightStateFacts,
  parseExtractedFacts
} from "../runtime/about-me";
import { loadTaskHistory } from "../runtime/history";
import { instructionsPrompt, loadInstructions } from "../runtime/instructions";
import { recallAnswer, recallFor, recallPrompt } from "../runtime/recall";
import type { BrowserTaskSessionEvidence } from "../runtime/session-evidence";
import {
  CHAT_APP_LABELS,
  describeSchedule,
  newScheduledTask,
  parseScheduleText,
  saveScheduledTask,
  splitDelivery
} from "../runtime/schedules";
import {
  addGrant,
  isGrantableHost,
  isHostGranted,
  loadSiteGrants,
  normalizeGrantHost,
  saveSiteGrants,
  SITE_GRANTS_KEY,
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
  Alert,
  AlertTitle,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  InputBase,
  Stack,
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
import { SettingsShell, type SectionId } from "./settings/SettingsShell";
import { PENDING_PROMPT_KEY, takePendingPrompt } from "./settings/handoff";
import { ModelMenu } from "./ModelMenu";
import { HistoryView } from "./HistoryView";
import { saveTaskHistoryEntry } from "../runtime/history";
import { waitForUserAction } from "../runtime/user-handoff";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** When it was said, shown in saved files. */
  at?: string;
  /** What the agent did, so the task can be saved as (or improve) a Skill. */
  learned?: { evidence: BrowserTaskSessionEvidence; task: string; skillId?: string };
  /** Set once the person saved or updated a Skill from this answer. */
  skillNote?: string;
  /** A Skill learned on its own from this answer, which the person can undo. */
  autoSkill?: { id: string; slug: string };
  /** Why a task couldn't finish, with the fix and a guide. */
  problem?: { problem: Problem; retry?: string; openAi?: boolean };
};

/** Thrown when the chosen AI failed the browser check, so the card can say so plainly. */
class CantUseBrowserError extends Error {
  constructor(readonly model: string) {
    super(`${model} did not pass the browser-control check. Pick another model from the model menu at the top.`);
  }
}

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

/** What is kept of a message in the saved chat. */
function toStored(message: Message): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.at ? { at: message.at } : {}),
    ...(message.problem ? { problem: message.problem } : {})
  };
}

function fromStored(message: ChatMessage): Message {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    at: message.at,
    ...(message.problem ? { problem: message.problem as Message["problem"] } : {})
  };
}

const now = () => new Date().toISOString();

/**
 * The chat. In the side panel the menu of chats and Spaces slides in from the
 * left; as a full page (chat.html) it stays open on the left, like Claude and
 * ChatGPT.
 */
export function App({ fullPage = false }: { fullPage?: boolean }) {
  const [view, setView] = useState<
    "chat" | "settings" | "history" | "skills" | "memory"
  >(() => {
    // Notifications open the panel page with ?view=scheduled.
    const asked = new URLSearchParams(location.search).get("view");
    return asked === "scheduled" ? "history" : asked === "skills" || asked === "memory" || asked === "history" ? asked : "chat";
  });
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined);
  const openSettings = (section?: SectionId) => {
    setSettingsSection(section);
    setView("settings");
  };
  // A request sent from the big Settings tab, waiting for the chat to be ready.
  const [queuedRun, setQueuedRun] = useState<string | null>(null);
  const [contextReady, setContextReady] = useState(false);
  const [historyTab, setHistoryTab] = useState<"past" | "scheduled">(() =>
    new URLSearchParams(location.search).get("view") === "scheduled" ? "scheduled" : "past"
  );
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [siteCommands, setSiteCommands] = useState<SiteCommand[]>([]);
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

  // Spaces and saved chats. Every chat is saved as it happens, in the Space
  // it was started in.
  const spaces = useSpaces();
  const [chatId, setChatId] = useState<string>(() => crypto.randomUUID());
  const chatSpace = useRef<string | null>(null);
  const skipNextSave = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(fullPage);
  const [saveMenu, setSaveMenu] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (skipNextSave.current) {
      // Just opened from the list: nothing new to save.
      skipNextSave.current = false;
      return;
    }
    if (!messages.length) return;
    if (!chatSpace.current && spaces.ready) chatSpace.current = spaces.active.id;
    void saveChatMessages(chatId, messages.map(toStored), chatSpace.current ?? undefined).catch(() => undefined);
  }, [messages]);

  const startNewChat = (closeMenu = true) => {
    if (running) return;
    setMessages([]);
    setActivities([]);
    setLastWorkflow(null);
    setChatId(crypto.randomUUID());
    chatSpace.current = null;
    setView("chat");
    if (closeMenu && !fullPage) setSidebarOpen(false);
  };

  const openChat = (chat: SavedChat) => {
    if (running) return;
    if (chat.id !== chatId) {
      skipNextSave.current = true;
      setMessages(chat.messages.map(fromStored));
      setActivities([]);
      setLastWorkflow(null);
      setChatId(chat.id);
      chatSpace.current = spaces.active.id;
    }
    setView("chat");
    if (!fullPage) setSidebarOpen(false);
  };

  // Moving to another Space starts a fresh chat there.
  useEffect(() => {
    if (!spaces.ready) return;
    // The menu stays open, so a chat in the new Space can be picked right away.
    if (chatSpace.current && chatSpace.current !== spaces.active.id) startNewChat(false);
  }, [spaces.active.id, spaces.ready]);

  const openFullPage = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("chat.html") });
    setSidebarOpen(false);
  };

  const currentChat = (): SavedChat => ({
    id: chatId,
    title: chatTitle(messages),
    created_at: messages[0]?.at ?? now(),
    updated_at: messages.at(-1)?.at ?? now(),
    messages: messages.map(toStored)
  });

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
    setContextReady(true);
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
    const id = crypto.randomUUID();
    setMessages((items) => [
      ...items,
      { id, role: "assistant", text, learned, at: now() }
    ]);
    return id;
  };

  const addProblemMessage = (problem: Problem, options: { retry?: string; openAi?: boolean } = {}) => {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "assistant", text: `${problem.title}. ${problem.reason}`, problem: { problem, ...options }, at: now() }
    ]);
  };

  useEffect(() => {
    void loadSkills().then(setSkills).catch(() => undefined);
    void loadSiteCommands().then(setSiteCommands).catch(() => undefined);
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && changes[SKILLS_STORAGE_KEY]) {
        void loadSkills().then(setSkills).catch(() => undefined);
      }
      if (
        area === "local" &&
        (changes[SKILLS_STORAGE_KEY] || changes[SITE_SKILL_LIBRARY_KEY] || changes[SITE_COMMAND_NAMES_KEY])
      ) {
        void loadSiteCommands().then(setSiteCommands).catch(() => undefined);
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

  /** What a finished task taught: a new Skill, a shorter one, a run count or a lesson. */
  const applyLearning = async (plan: ReturnType<typeof planLearning>, messageId: string) => {
    const saved = await applyLearningPlan(plan, RESERVED_COMMANDS);
    if (plan.kind === "learn" && saved) {
      setMessages((items) =>
        items.map((item) =>
          item.id === messageId
            ? {
                ...item,
                autoSkill: { id: saved.id, slug: saved.slug },
                skillNote: `Learned this as /${saved.slug}. I'll follow it next time you ask something similar, or run it with /${saved.slug}.`
              }
            : item
        )
      );
    } else if (plan.kind === "improve" && saved) {
      noteOnMessage(messageId, `Found a shorter way and updated /${saved.slug}.`);
    }
  };

  const undoAutoSkill = async (message: Message) => {
    if (!message.autoSkill) return;
    await deleteSkill(message.autoSkill.id);
    setMessages((items) =>
      items.map((item) =>
        item.id === message.id
          ? { ...item, autoSkill: undefined, skillNote: `Forgot /${message.autoSkill?.slug}.` }
          : item
      )
    );
  };

  /** A website command runs straight away: no model, just the learned recipe. */
  const runSiteCommand = async (command: SiteCommand, args: string) => {
    const values = parseCommandArgs(command, args);
    const checked = recipeParameters(command, values);
    if (!checked.ok) {
      addAssistantMessage(checked.error);
      return;
    }
    const sessionId = `site-command-${crypto.randomUUID()}`;
    const call = (approvalGranted: boolean) =>
      extensionMessage<unknown>({
        type: "BROWSER_TOOL",
        tool: "site_commands",
        input: { name: command.name, parameters: values },
        session_id: sessionId,
        session_title: command.title,
        approval_granted: approvalGranted
      });
    const activity = addActivity(`Running /${command.name} on ${command.site}`);
    setRunning(true);
    try {
      let result = await call(false);
      if (!result.ok && result.error?.code === "APPROVAL_REQUIRED") {
        const approved = await requestApproval(result.error.message, command.site);
        if (!approved) {
          finishActivity(activity, "error");
          addAssistantMessage("I stopped before sending anything.");
          return;
        }
        result = await call(true);
      }
      finishActivity(activity, result.ok ? "done" : "error");
      addAssistantMessage(siteCommandAnswer(command, result));
      if (command.kind === "read") {
        // The data is in the answer; the tab it used is no longer needed.
        await extensionMessage({
          type: "BROWSER_TOOL",
          tool: "close_session",
          input: {},
          session_id: sessionId,
          session_title: command.title
        }).catch(() => undefined);
      }
    } finally {
      setRunning(false);
    }
  };

  const runCommand = async (command: SlashCommand, typed: string) => {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: typed, at: now() }
    ]);
    if (command.kind === "unknown") {
      addAssistantMessage(
        `There's no command or Skill called /${command.name}. Type / to see them, or /help for the list.`
      );
      return;
    }
    if (command.kind === "site") {
      await runSiteCommand(command.command, command.args);
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
      case "recall":
        addAssistantMessage(recallAnswer(await loadTaskHistory().catch(() => []), command.args));
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
        const delivery = splitDelivery(parsed.task);
        const item = { ...newScheduledTask(delivery.task || parsed.task, parsed.schedule), deliver_to: delivery.deliver_to };
        if (!item.next_run_at) {
          addAssistantMessage("That time has already passed. Pick a time in the future.");
          return;
        }
        await saveScheduledTask(item);
        addAssistantMessage(
          `Scheduled: **${item.task}**\n\n${describeSchedule(item.schedule)}. Next run ${new Date(item.next_run_at).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" })}. It runs in its own background tab while Chrome is open, and anything that needs your approval waits for you.${item.deliver_to ? ` Each result also goes to ${CHAT_APP_LABELS[item.deliver_to]} (through the helper app).` : ""} See it under History → Scheduled.`
        );
        return;
      }
      default:
        addAssistantMessage(helpText(await loadSkills(), await loadSiteCommands().catch(() => [])));
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
    const load = () =>
      void loadSiteGrants()
        .then((items) => {
          siteGrants.current = items;
        })
        .catch(() => undefined);
    load();
    // A website removed in Settings must ask again right away.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && SITE_GRANTS_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    const take = async () => {
      const pending = await takePendingPrompt().catch(() => null);
      if (!pending) return;
      setView("chat");
      if (pending.run) setQueuedRun(pending.text);
      else setPrompt(pending.text);
    };
    void take();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[PENDING_PROMPT_KEY]?.newValue) void take();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
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
      addActivity(`Went ahead without asking (you chose not to be asked): ${description}`, "done");
      return true;
    }
    const host =
      hostOverride ?? (approvalHost.current || safeHostname(tab?.url));
    if (host && isHostGranted(siteGrants.current, host)) {
      addActivity(`Went ahead without asking (you allowed ${host}): ${description}`, "done");
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
  const saved = useSaved();
  const askCurrentAi = async (text: string) => {
    if (!primary) throw new Error("No AI is connected");
    const routed = await directChatWithFallback(
      primary,
      fallback?.chatHealth.status === "healthy" ? fallback : null,
      text
    );
    return routed.result;
  };
  const polishContext = () => {
    const match = matchSkill(prompt, skills);
    return {
      page: /^https?:/.test(tab?.url || "") ? { title: tab?.title, url: tab?.url } : undefined,
      skill: match ? { name: match.skill.slug, instructions: match.skill.instructions } : undefined
    };
  };
  const handlePolish = () => {
    if (!prompt.trim() || polishing || !primary) return;
    setPolishing(true);
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
    const savedSkills = await loadSkills().catch(() => []);
    const command = parseSlashCommand(typed, savedSkills, await loadSiteCommands().catch(() => []));
    if (command.kind === "builtin" || command.kind === "unknown" || command.kind === "site") {
      setPrompt("");
      await runCommand(command, typed);
      return;
    }
    const skillRun = command.kind === "skill" ? command.skill : null;
    const task = skillRun ? skillTask(skillRun, command.kind === "skill" ? command.args : "") : typed;

    // A model the user picked from the model menu may not have been checked
    // yet: try it. Only send them to settings when nothing usable is chosen.
    if (!primary || !hasCredentials(primary) || !primary.model) {
      openSettings("ai");
      return;
    }

    setPrompt("");
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: typed, at: now() }
    ]);
    setActivities([]);
    setRunning(true);
    setPaused(false);
    pausedRef.current = false;
    cancelled.current = false;

    // About me: pick up plain facts from the request, then share what is known.
    let aboutMe = "";
    let autoSkills = true;
    let learnAboutMe = false;
    try {
      const preferences = await loadPreferences();
      autoSkills = preferences.autoSkills;
      learnAboutMe = preferences.learnAboutMe && !skillRun;
      if (preferences.learnAboutMe && !skillRun) {
        const learned = await addFacts(factsInMessage(typed), "learned");
        if (learned.length) {
          addActivity(
            `Remembered about you: ${learned.map((fact) => fact.text).join("; ")}`,
            "done"
          );
        }
      }
      aboutMe = instructionsPrompt(await loadInstructions()) + aboutMePrompt(await loadAboutMe());
    } catch {
      aboutMe = "";
    }

    // Past conversations the request refers back to (or closely repeats).
    const recalledEntries = skillRun ? [] : recallFor(await loadTaskHistory().catch(() => []), typed);
    const recalled = recallPrompt(recalledEntries);
    if (recalledEntries.length) {
      addActivity(
        `Remembering ${recalledEntries.length} past conversation${recalledEntries.length === 1 ? "" : "s"}`,
        "done"
      );
    }

    // Lasting facts the patterns miss ("I work at…", "my kids are…") are
    // picked out by the model after the answer, without holding it up.
    const learnFactsInBackground = (model: ProviderConnection) => {
      if (!learnAboutMe || !mightStateFacts(typed)) return;
      void (async () => {
        const reply = await directChatWithFallback(model, null, factExtractionPrompt(typed, await loadAboutMe()));
        const added = await addFacts(parseExtractedFacts(reply.result), "learned");
        if (added.length) {
          addActivity(`Remembered about you: ${added.map((fact) => fact.text).join("; ")}`, "done");
        }
      })().catch(() => undefined);
    };

    // A saved Skill that looks like this request guides the agent.
    const hinted = !skillRun && autoSkills ? matchSkill(typed, savedSkills)?.skill ?? null : null;
    const usedSkill = skillRun ?? hinted;
    const intent = usedSkill ? "browser" : classifyTaskIntent(task);
    // Earlier turns of this chat, so follow-ups like "make it shorter" make sense.
    const earlier = skillRun ? "" : chatContextPrompt(messages.filter((item) => !item.problem));

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
            task + earlier + aboutMe + recalled,
            controller.signal
          );

          finishActivity(activity);
          if (routed.usedFallback) {
            const fallbackActivity = addActivity(
              "Your main AI didn't answer, so your backup AI did",
              "done"
            );
            finishActivity(fallbackActivity);
          }

          addAssistantMessage(routed.result);
          await saveHistory(typed, routed.result);
          learnFactsInBackground(primary);
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
        throw new CantUseBrowserError(primary.model);
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

      if (hinted) addActivity(`Following your Skill /${hinted.slug}`, "done");

      const result = await runAgentTask(task + attachmentNote, {
        context: earlier + aboutMe + recalled + (hinted ? skillHint(hinted) : ""),
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
      const messageId = addAssistantMessage(
        result.message,
        result.status === "completed" && (usedSkill || worthSaving(evidence))
          ? { evidence, task: typed, ...(usedSkill ? { skillId: usedSkill.id } : {}) }
          : undefined
      );
      if (!cancelled.current) {
        await applyLearning(
          planLearning({
            task: typed,
            status: result.status,
            message: result.message,
            evidence,
            used: usedSkill,
            autoSkills
          }),
          messageId
        ).catch(() => undefined);
      }
      if (result.status === "completed") {
        await saveHistory(typed, result.message);
      }
      learnFactsInBackground(primary);
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
        addProblemMessage(diagnoseAi("Request timed out: the AI stopped answering partway", aiContext(primary)), { retry: typed });
      } else if (error instanceof CantUseBrowserError) {
        addProblemMessage(cantUseBrowser(error.model), { openAi: true });
      } else {
        addProblemMessage(diagnoseAi(error, aiContext(primary)), { retry: typed });
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

  useEffect(() => {
    if (!queuedRun || !contextReady || running) return;
    const text = queuedRun;
    setQueuedRun(null);
    void runTask(text);
  }, [queuedRun, contextReady, running]);

  const commandSuggestions = slashSuggestions(prompt, skills, siteCommands);

  const goTo = (screen: SidebarScreen) => {
    if (screen === "settings") openSettings();
    else setView(screen);
    if (!fullPage) setSidebarOpen(false);
  };

  const exportChat = async (kind: "md" | "txt" | "copy") => {
    setSaveMenu(null);
    // The saved copy has the name the person may have given it.
    const chat = (await getChat(chatId, chatSpace.current ?? undefined).catch(() => null)) ?? currentChat();
    if (kind === "copy") {
      await navigator.clipboard.writeText(chatToText(chat, spaces.active.name)).catch(() => undefined);
      saved("Whole chat copied");
      return;
    }
    saveTextFile(
      kind === "md" ? chatToMarkdown(chat, spaces.active.name) : chatToText(chat, spaces.active.name),
      chatFileName(chat.title, kind),
      kind === "md" ? "text/markdown" : "text/plain"
    );
    saved("Chat saved to your Downloads folder");
  };

  const sidebar = (
    <Sidebar
      spaces={spaces.spaces}
      active={spaces.active}
      currentChatId={chatId}
      busy={running}
      fullPage={fullPage}
      onNewChat={() => startNewChat()}
      onOpenChat={openChat}
      onChatDeleted={(id) => {
        if (id === chatId) startNewChat();
      }}
      onScreen={goTo}
      onManageSpaces={() => {
        openSettings("spaces");
        if (!fullPage) setSidebarOpen(false);
      }}
      onOpenFullPage={fullPage ? undefined : openFullPage}
      onClose={fullPage ? undefined : () => setSidebarOpen(false)}
    />
  );

  /** In the full page the menu stays on the left and the screen sits beside it. */
  const frame = (content: ReactNode, wide = false) => {
    // A new Space shows its own notes and history straight away.
    const screen = <Fragment key={spaces.active.id}>{content}</Fragment>;
    if (!fullPage) {
      return (
        <>
          {screen}
          <Drawer open={sidebarOpen} onClose={() => setSidebarOpen(false)} slotProps={{ paper: { sx: { width: 300, maxWidth: "88vw" } } }}>
            {sidebar}
          </Drawer>
        </>
      );
    }
    return (
      <Box sx={{ display: "flex", height: "100vh", bgcolor: "background.default" }}>
        {sidebarOpen && (
          <Box component="aside" sx={{ width: 290, flexShrink: 0, borderRight: 1, borderColor: "divider", height: "100vh" }}>
            {sidebar}
          </Box>
        )}
        <Box component="main" sx={{ flex: 1, minWidth: 0, height: "100vh", overflowY: "auto" }}>
          {wide ? screen : <Box sx={{ maxWidth: 900, mx: "auto" }}>{screen}</Box>}
        </Box>
      </Box>
    );
  };

  if (view === "settings") {
    return frame(
      <SettingsShell
        mode="panel"
        initialSection={settingsSection}
        onClose={() => setView("chat")}
        actions={{
          runTask: (text) => {
            setView("chat");
            void runTask(text);
          },
          fillPrompt: (text) => {
            setPrompt(text);
            setView("chat");
          },
          replay: (workflow) => {
            setView("chat");
            void replayWorkflow(workflow);
          }
        }}
      />
    );
  }

  if (view === "skills") {
    return frame(
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
        onUseCommand={(name) => {
          setPrompt(`/${name} `);
          setView("chat");
        }}
      />
    );
  }

  if (view === "memory") {
    return frame(<MemoryView onBack={() => setView("chat")} />);
  }

  if (view === "history") {
    return frame(
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

  const column = fullPage ? { maxWidth: 820, width: "100%", mx: "auto" } : {};

  return frame(
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
        <Toolbar variant="dense" sx={{ minHeight: 56, gap: 0.5, px: { xs: 1, sm: 1.5 } }}>
          <Tooltip title={fullPage ? (sidebarOpen ? "Hide the menu" : "Show the menu") : "Menu: your chats, Spaces and settings"}>
            <IconButton
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label={fullPage && sidebarOpen ? "Hide the menu" : "Open the menu"}
            >
              <MenuIcon />
            </IconButton>
          </Tooltip>
          <Box sx={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 1 }}>
            {fullPage ? (
              <Typography variant="subtitle1" noWrap sx={{ minWidth: 0 }} data-testid="chat-title">
                {messages.length ? chatTitle(messages) : "New chat"}
              </Typography>
            ) : (
              <>
                <Box component="img" src="/icons/icon48.png" alt="BrowserHarness" title="BrowserHarness" sx={{ width: 26, height: 26, borderRadius: 1.25 }} />
                <Tooltip title="The Space you're in. Click to switch">
                  <Chip
                    size="small"
                    variant="outlined"
                    onClick={() => setSidebarOpen(true)}
                    avatar={<Box sx={{ display: "inline-flex", bgcolor: "transparent !important" }}><SpaceBadge space={spaces.active} size={18} /></Box>}
                    label={spaces.active.name}
                    data-testid="space-chip"
                    sx={{ maxWidth: 160, fontWeight: 600 }}
                  />
                </Tooltip>
              </>
            )}
          </Box>

          {messages.length > 0 && (
            <Tooltip title="Save or copy this chat">
              <IconButton size="small" onClick={(event) => setSaveMenu(event.currentTarget)} aria-label="Save this chat">
                <SaveFileIcon />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={running ? "Wait for the task to finish, or press Stop" : "New chat"}>
            <span>
              <IconButton size="small" onClick={() => startNewChat()} disabled={running} aria-label="New chat">
                <NewChatIcon />
              </IconButton>
            </span>
          </Tooltip>
          {!fullPage && (
            <Tooltip title="Open the chat as a full page, with more room">
              <IconButton size="small" onClick={openFullPage} aria-label="Open as a full page">
                <FullPageIcon />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Settings">
            <IconButton size="small" onClick={() => openSettings()} aria-label="Settings">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
          <Menu anchorEl={saveMenu} open={Boolean(saveMenu)} onClose={() => setSaveMenu(null)}>
            <MenuItem onClick={() => void exportChat("md")}>
              <ListItemIcon>
                <SaveFileIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Save as a document" secondary="Keeps headings and lists; opens in notes apps and Google Docs" />
            </MenuItem>
            <MenuItem onClick={() => void exportChat("txt")}>
              <ListItemIcon>
                <SaveFileIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Save as plain text" secondary="Opens anywhere" />
            </MenuItem>
            <MenuItem onClick={() => void exportChat("copy")}>
              <ListItemIcon>
                <CopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Copy the whole chat" secondary="Then paste it into an email or a document" />
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box sx={{ px: 2, pt: 1.5, ...column }}>
        <Stack direction="row" spacing={1} sx={{ overflowX: "auto", pb: 0.5 }}>
          {/^https?:/.test(tab?.url || "") && <Tooltip title="BrowserHarness works on the tab you are looking at">
            <Chip
              size="small"
              label={`On: ${tab?.title || safeHostname(tab?.url) || "this tab"}`}
              variant="outlined"
              sx={{ maxWidth: "100%" }}
            />
          </Tooltip>}
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

      <Box sx={{ flex: 1, p: 2, overflowY: "auto", ...column }}>
        {messages.length === 0 ? (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={2}
            sx={{ minHeight: fullPage ? "55vh" : 300, textAlign: "center" }}
          >
            <Typography variant="h5">Give your browser a task.</Typography>
            {spaces.spaces.length > 1 && (
              <Stack direction="row" spacing={0.75} alignItems="center" data-testid="space-note">
                <SpaceBadge space={spaces.active} size={18} />
                <Typography variant="body2" color="text.secondary">
                  You're in {spaces.active.name}. This chat stays in this Space.
                </Typography>
              </Stack>
            )}
            <Typography color="text.secondary" sx={{ maxWidth: 320 }}>
              Type what you want, the way you would ask a person. BrowserHarness reads pages, clicks and types for
              you, and asks before anything important.
            </Typography>
            {!primary && (
              <Stack spacing={1} alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  First, connect an AI. It takes about a minute.
                </Typography>
                <Button variant="contained" size="large" onClick={() => openSettings("ai")}>
                  Connect your AI
                </Button>
              </Stack>
            )}
            <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="center">
              {(fullPage
                ? ["Compare prices for an electric kettle", "Find a quick dinner recipe", "Plan a weekend trip to Goa"]
                : ["Summarize this page", "Find the cheapest option here", "Help me fill in this form"]
              ).map(
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
                    p: message.problem ? 0 : 1.5,
                    bgcolor:
                      message.role === "user" ? "action.hover" : "transparent"
                  }}
                >
                  {message.problem ? (
                    <ProblemCard
                      problem={message.problem.problem}
                      heading="Couldn't finish"
                      severity={message.problem.openAi ? "warning" : "error"}
                      retryLabel={message.problem.openAi ? "Choose another AI" : "Try again"}
                      onRetry={
                        message.problem.openAi
                          ? () => openSettings("ai")
                          : message.problem.retry && !running
                            ? () => void runTask(message.problem!.retry)
                            : undefined
                      }
                    />
                  ) : message.role === "assistant" ? (
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
                      <Tooltip title="Copy this answer">
                        <IconButton
                          size="small"
                          aria-label="Copy this answer"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(message.text)
                              .then(() => saved("Answer copied"))
                              .catch(() => undefined)
                          }
                          sx={{ mt: 0.5, opacity: 0.6 }}
                        >
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
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
                          {message.autoSkill && (
                            <Button size="small" onClick={() => void undoAutoSkill(message)} sx={{ ml: 0.5, minWidth: 0 }}>
                              Undo
                            </Button>
                          )}
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
                <Typography variant="caption" color="text.secondary" fontWeight={600}>
                  {running ? "What I'm doing" : "What I did"}
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
                        <Box
                          component="span"
                          aria-label={activity.state === "done" ? "Done" : "Didn't work"}
                          sx={{ display: "inline-flex", color: activity.state === "done" ? "success.main" : "warning.main" }}
                        >
                          {activity.state === "done" ? <YesIcon fontSize="small" /> : <WarningIcon fontSize="small" />}
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
                <AlertTitle>Is it OK to go ahead?</AlertTitle>
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

      <Box sx={{ px: 1.5, pb: 1.5, pt: 0.5, position: "sticky", bottom: 0, bgcolor: "background.default", ...column }}>
        {running && (
          <Stack direction="row" alignItems="center" spacing={1} mb={1} px={0.5}>
            <CircularProgress size={14} />
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
              {paused ? "Paused" : "Working on it…"}
            </Typography>
            <Button
              size="small"
              startIcon={paused ? <RunIcon /> : <PauseIcon />}
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
        <Paper
          variant="outlined"
          data-testid="composer"
          sx={{
            borderRadius: 4,
            px: 1.25,
            pt: 1,
            pb: 0.75,
            bgcolor: "background.paper",
            transition: "border-color .15s, box-shadow .15s",
            "&:focus-within": { borderColor: "primary.main", boxShadow: (theme) => `0 0 0 3px ${theme.palette.primary.main}22` }
          }}
        >
          <InputBase
            multiline
            minRows={2}
            maxRows={8}
            fullWidth
            placeholder={primary ? "What should I do? Type / for your Skills" : "Connect an AI first, then tell me what to do"}
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
            inputProps={{ "aria-label": "Your request" }}
            sx={{ px: 0.5, fontSize: "1rem", lineHeight: 1.5 }}
          />
          <Stack direction="row" alignItems="center" spacing={0.25} mt={0.5}>
            <Tooltip title="Add files (up to 5 MB each)">
              <span>
                <IconButton size="small" onClick={() => fileInput.current?.click()} disabled={running} aria-label="Attach files">
                  <AddIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={primary ? "Improve my request: answer a few questions and your AI rewrites it" : "Connect an AI first"}>
              <span>
                <IconButton
                  size="small"
                  onClick={handlePolish}
                  disabled={!prompt.trim() || running || polishing || !primary}
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
            <Tooltip title={recording ? "Finish teaching" : "Teach by showing: record what you do"}>
              <span>
                <IconButton
                  size="small"
                  color={recording ? "error" : "default"}
                  onClick={() => void handleRecord()}
                  disabled={running}
                  aria-label={recording ? "Finish recording" : "Record workflow"}
                >
                  <RecordIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            <ModelMenu current={primary} onChanged={refreshContext} onManage={() => openSettings("ai")} above />
            {running ? (
              <Tooltip title="Stop current task">
                <IconButton
                  onClick={handleStop}
                  aria-label="Stop current task"
                  sx={{ bgcolor: "error.main", color: "#fff", width: 34, height: 34, "&:hover": { bgcolor: "error.dark" } }}
                >
                  <StopIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Send (Enter)">
                <span>
                  <IconButton
                    onClick={() => void runTask()}
                    disabled={!prompt.trim() || recording}
                    aria-label="Send"
                    sx={{
                      bgcolor: "primary.main",
                      color: "primary.contrastText",
                      width: 34,
                      height: 34,
                      "&:hover": { bgcolor: "primary.dark" },
                      "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" }
                    }}
                  >
                    <SendIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Stack>
        </Paper>
        <PolishDialog
          open={polishing}
          draft={prompt}
          context={polishing ? polishContext() : {}}
          ai={primary ? aiContext(primary) : {}}
          ask={askCurrentAi}
          onClose={() => setPolishing(false)}
          onDone={(improved, answered) => {
            setPolishing(false);
            setPrompt(improved);
            saved(answered ? `Request improved with your ${answered} answer${answered === 1 ? "" : "s"}. Check it, then press Send` : "Request improved. Check it, then press Send");
          }}
        />
      </Box>
    </Box>,
    true
  );
}
