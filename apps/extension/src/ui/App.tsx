import { useEffect, useRef, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import PauseIcon from "@mui/icons-material/Pause";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import StopIcon from "@mui/icons-material/Stop";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from "@mui/material";
import { loadProviderConfig, type ProviderConfig } from "../settings/provider-store";
import { nextAgentDecision } from "../runtime/model-client";
import type { PageObservation, ToolResult } from "../runtime/protocol";
import { SettingsView } from "./SettingsView";

type Message = { id: string; role: "user" | "assistant"; text: string };
type Activity = { id: string; text: string; state: "working" | "done" | "error" };
type CurrentTab = { tab_id: number; title?: string; url?: string };
type Approval = {
  description: string;
  resolve: (approved: boolean) => void;
};

const APPROVAL_WORDS = /\b(send|submit|publish|buy|purchase|checkout|place order|pay|delete|remove|change password|security)\b/i;

async function extensionMessage<T>(request: unknown): Promise<ToolResult<T>> {
  return chrome.runtime.sendMessage(request);
}

function approvalDescription(observation: PageObservation, input: Record<string, unknown>) {
  const id = input.element_id;
  const element = observation.elements.find((candidate) => candidate.element_id === id);
  if (!element || !APPROVAL_WORDS.test(element.accessible_name)) return null;
  return `Click “${element.accessible_name || "this control"}” on ${new URL(observation.url).hostname}`;
}

export function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [tab, setTab] = useState<CurrentTab | null>(null);
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
  const cancelled = useRef(false);
  const pausedRef = useRef(false);

  const refreshContext = async () => {
    const [currentTab, provider] = await Promise.all([
      extensionMessage<CurrentTab>({ type: "GET_CURRENT_TAB" }),
      loadProviderConfig()
    ]);
    if (currentTab.ok && currentTab.data) setTab(currentTab.data);
    setConfig(provider);
  };

  useEffect(() => {
    void refreshContext();
  }, [view]);

  const addActivity = (text: string, state: Activity["state"] = "working") => {
    const id = crypto.randomUUID();
    setActivities((items) => [...items.slice(-6), { id, text, state }]);
    return id;
  };

  const finishActivity = (id: string, state: Activity["state"] = "done") => {
    setActivities((items) => items.map((item) => (item.id === id ? { ...item, state } : item)));
  };

  const requestApproval = (description: string) =>
    new Promise<boolean>((resolve) => setApproval({ description, resolve }));

  const runTask = async () => {
    const task = prompt.trim();
    if (!task || running) return;
    if (!config?.apiKey || !config.model) {
      setView("settings");
      return;
    }

    setPrompt("");
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: task }]);
    setActivities([]);
    setRunning(true);
    setPaused(false);
    pausedRef.current = false;
    cancelled.current = false;

    try {
      const trail: string[] = [];
      let observationResult = await extensionMessage<PageObservation>({
        type: "BROWSER_TOOL",
        tool: "observe_page",
        input: {}
      });
      if (!observationResult.ok || !observationResult.data) {
        throw new Error(observationResult.error?.message || "Could not observe this page");
      }
      let observation = observationResult.data;

      for (let step = 0; step < 12 && !cancelled.current; step += 1) {
        while (pausedRef.current && !cancelled.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        }

        const thinking = addActivity(step === 0 ? "Reading the current page" : "Deciding the next action");
        const decision = await nextAgentDecision(config, task, observation, trail);
        finishActivity(thinking);

        if (decision.kind === "final") {
          setMessages((items) => [
            ...items,
            { id: crypto.randomUUID(), role: "assistant", text: decision.message }
          ]);
          await saveHistory(task, decision.message);
          return;
        }

        const description = approvalDescription(observation, decision.input);
        if (decision.tool === "click" && description) {
          const approved = await requestApproval(description);
          setApproval(null);
          if (!approved) {
            setMessages((items) => [
              ...items,
              { id: crypto.randomUUID(), role: "assistant", text: "I stopped before that action." }
            ]);
            return;
          }
        }

        const activityId = addActivity(decision.note || `Using ${decision.tool}`);
        const result = await extensionMessage({
          type: "BROWSER_TOOL",
          tool: decision.tool,
          input: decision.input
        });
        finishActivity(activityId, result.ok ? "done" : "error");
        trail.push(`${decision.tool}: ${JSON.stringify(result)}`);

        if (!result.ok && result.error?.code === "ELEMENT_NOT_FOUND") {
          trail.push("Element became stale; re-observing before retry.");
        }

        if (["navigate", "click", "type", "press_key", "scroll", "open_tab", "switch_tab"].includes(decision.tool)) {
          await extensionMessage({ type: "BROWSER_TOOL", tool: "wait", input: { milliseconds: 450 } });
        }

        observationResult = await extensionMessage<PageObservation>({
          type: "BROWSER_TOOL",
          tool: "observe_page",
          input: {}
        });
        if (!observationResult.ok || !observationResult.data) {
          throw new Error(observationResult.error?.message || "Could not verify the page after the action");
        }
        observation = observationResult.data;
      }

      if (cancelled.current) {
        setMessages((items) => [
          ...items,
          { id: crypto.randomUUID(), role: "assistant", text: "Stopped." }
        ]);
      } else {
        throw new Error("Task reached the v0.1 action limit before completion");
      }
    } catch (error) {
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: error instanceof Error ? error.message : "BrowserCrew hit an unexpected error."
        }
      ]);
    } finally {
      setRunning(false);
      setPaused(false);
      pausedRef.current = false;
      cancelled.current = false;
    }
  };

  const saveHistory = async (task: string, result: string) => {
    const key = "browsercrew.taskHistory";
    const stored = await chrome.storage.local.get(key);
    const previous = Array.isArray(stored[key]) ? stored[key] : [];
    await chrome.storage.local.set({
      [key]: [{ task, result, timestamp: new Date().toISOString(), url: tab?.url }, ...previous].slice(0, 50)
    });
  };

  if (view === "settings") return <SettingsView onBack={() => setView("chat")} />;

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <AppBar position="sticky" color="transparent" elevation={0} sx={{ borderBottom: 1, borderColor: "divider", backdropFilter: "blur(12px)" }}>
        <Toolbar variant="dense" sx={{ minHeight: 56, gap: 1 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>BrowserCrew</Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {tab?.url ? new URL(tab.url).hostname : "No supported tab"}
            </Typography>
          </Box>

          <Button size="small" onClick={(event) => setModelAnchor(event.currentTarget)}>
            {config?.model || "Connect AI"}
          </Button>
          <Menu anchorEl={modelAnchor} open={Boolean(modelAnchor)} onClose={() => setModelAnchor(null)}>
            <MenuItem disabled>{config ? config.provider : "No provider connected"}</MenuItem>
            <MenuItem onClick={() => { setModelAnchor(null); setView("settings"); }}>Manage models…</MenuItem>
          </Menu>
          <Tooltip title="Settings">
            <IconButton size="small" onClick={() => setView("settings")} aria-label="Settings">
              <SettingsOutlinedIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ px: 2, pt: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ overflowX: "auto", pb: 0.5 }}>
          <Chip size="small" label="Personal" variant="outlined" />
          <Chip size="small" label={tab?.title || "Current tab"} variant="outlined" />
        </Stack>
      </Box>

      <Box sx={{ flex: 1, p: 2, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ minHeight: 300, textAlign: "center" }}>
            <Typography variant="h5">Give your browser a task.</Typography>
            <Typography color="text.secondary" sx={{ maxWidth: 300 }}>
              Ask BrowserCrew to read, navigate, compare, fill, or work across tabs.
            </Typography>
            {!config && <Button variant="contained" onClick={() => setView("settings")}>Connect your AI</Button>}
            <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="center">
              {["Summarize this page", "Find the best option", "Fill this form"].map((suggestion) => (
                <Chip key={suggestion} label={suggestion} onClick={() => setPrompt(suggestion)} />
              ))}
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={2}>
            {messages.map((message) => (
              <Box key={message.id} sx={{ alignSelf: message.role === "user" ? "flex-end" : "stretch", maxWidth: message.role === "user" ? "88%" : "100%" }}>
                <Paper variant={message.role === "user" ? "outlined" : "elevation"} elevation={message.role === "assistant" ? 0 : 0} sx={{ p: 1.5, bgcolor: message.role === "user" ? "action.hover" : "transparent" }}>
                  <Typography variant="body2">{message.text}</Typography>
                </Paper>
              </Box>
            ))}

            {activities.length > 0 && (
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">Agent activity</Typography>
                <Stack spacing={0.75} mt={1}>
                  {activities.map((activity) => (
                    <Stack key={activity.id} direction="row" spacing={1} alignItems="center">
                      {activity.state === "working" ? <CircularProgress size={13} /> : <Box component="span">{activity.state === "done" ? "✓" : "!"}</Box>}
                      <Typography variant="body2">{activity.text}</Typography>
                    </Stack>
                  ))}
                </Stack>
              </Paper>
            )}

            {approval && (
              <Alert severity="warning" action={
                <Stack direction="row" spacing={0.5}>
                  <Button size="small" onClick={() => approval.resolve(false)}>Cancel</Button>
                  <Button size="small" variant="contained" onClick={() => approval.resolve(true)}>Approve</Button>
                </Stack>
              }>
                BrowserCrew wants to: {approval.description}
              </Alert>
            )}
          </Stack>
        )}
      </Box>

      <Divider />
      <Box sx={{ p: 1.5 }}>
        {running && (
          <Stack direction="row" spacing={1} mb={1}>
            <Button size="small" startIcon={<PauseIcon />} onClick={() => setPaused((value) => { const next = !value; pausedRef.current = next; return next; })}>
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="small" color="error" startIcon={<StopIcon />} onClick={() => { cancelled.current = true; pausedRef.current = false; setPaused(false); }}>
              Stop
            </Button>
          </Stack>
        )}
        <TextField
          multiline
          maxRows={5}
          fullWidth
          placeholder="Ask BrowserCrew…"
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
                  <Tooltip title="Attach/context — next MVP slice"><span><IconButton size="small" disabled><AddIcon /></IconButton></span></Tooltip>
                  <Tooltip title="Watch Me & Learn — MVP"><IconButton size="small" onClick={() => setPrompt((value) => value || "Record this workflow")}><FiberManualRecordIcon fontSize="small" /></IconButton></Tooltip>
                  <IconButton size="small" color="primary" onClick={() => void runTask()} disabled={!prompt.trim() || running} aria-label="Send">
                    <SendRoundedIcon />
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
