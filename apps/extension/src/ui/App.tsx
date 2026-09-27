import { useEffect, useRef, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import PauseIcon from "@mui/icons-material/Pause";
import ReplayIcon from "@mui/icons-material/Replay";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
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
import {
  loadActiveConnection,
  loadFallbackConnection,
  type ProviderConnection
} from "../settings/provider-store";
import {
  directChatWithFallback,
  agentDecisionWithFallback
} from "../runtime/model-router";
import { runBrowserTask } from "../runtime/browser-engine";
import { replaySavedWorkflowAdaptive } from "../runtime/workflow-adaptive-replay";
import type { AdaptiveReplayDependencies } from "../runtime/adaptive-replay";
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
import { HistoryView } from "./HistoryView";
import { saveTaskHistoryEntry } from "../runtime/history";

type Message = { id: string; role: "user" | "assistant"; text: string };
type Activity = { id: string; text: string; state: "working" | "done" | "error" };
type CurrentTab = { tab_id: number; title?: string; url?: string };
type Approval = {
  description: string;
  resolve: (approved: boolean) => void;
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
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [lastWorkflow, setLastWorkflow] = useState<SavedWorkflow | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
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

  const requestApproval = (description: string) =>
    new Promise<boolean>((resolve) => setApproval({ description, resolve }));

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
        "Recording across pages and tabs. Show BrowserCrew the workflow you want it to learn; navigation, new tabs, clicks, text entry, Enter and Tab are captured. Password fields are never recorded."
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
            input: Record<string, unknown> = {}
          ) =>
            extensionMessage<T>({
              type: "BROWSER_TOOL",
              tool,
              input,
              session_id: taskSessionId,
              session_title: taskSessionTitle
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
            `Replay “${step.locator.accessible_name || "this action"}” on ${currentHost || "this page"}`
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
            `Replay Enter in “${step.locator.accessible_name || step.locator.role}” on ${currentHost || "this page"}; this may submit a form`
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

  const runTask = async () => {
    const task = prompt.trim();
    if (!task || running) return;

    if (
      !primary?.apiKey ||
      !primary.model ||
      primary.chatHealth.status !== "healthy"
    ) {
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
        primary.agentHealth.status === "healthy"
          ? primary
          : fallback?.agentHealth.status === "healthy"
            ? fallback
            : null;

      if (!agentPrimary) {
        throw new Error(
          "No validated Agent-capable model is available. Open Models & connections and run the Agent capability check."
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
        task,
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
              screenshotDataUrl
            );
            return {
              decision: routed.result,
              usedFallback: routed.usedFallback
            };
          },
          tool: (tool, input = {}) =>
            extensionMessage({
              type: "BROWSER_TOOL",
              tool,
              input,
              session_id: taskSessionId,
              session_title: taskSessionTitle
            }),
          approvalDescription: (observation, tool, input) =>
            approvalDescription(observation, tool, input),
          requestApproval: async (description) => {
            const approved = await requestApproval(description);
            setApproval(null);
            return approved;
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
            : "BrowserCrew hit an unexpected error."
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
    requestAbort.current?.abort();
    requestAbort.current = null;
    pausedRef.current = false;
    setPaused(false);
    if (approval) {
      approval.resolve(false);
      setApproval(null);
    }
  };

  if (view === "settings") {
    return <SettingsView onBack={() => setView("chat")} />;
  }

  if (view === "history") {
    return <HistoryView onBack={() => setView("chat")} />;
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
              BrowserCrew
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
          <Button size="small" onClick={(event) => setModelAnchor(event.currentTarget)}>
            {fallback ? "Auto" : primary?.model || "Connect AI"}
          </Button>
          <Menu
            anchorEl={modelAnchor}
            open={Boolean(modelAnchor)}
            onClose={() => setModelAnchor(null)}
          >
            {primary ? (
              <MenuItem disabled>
                {`Primary · ${primary.label}`}
              </MenuItem>
            ) : (
              <MenuItem disabled>No provider connected</MenuItem>
            )}
            {fallback && (
              <MenuItem disabled>
                {`Fallback · ${fallback.label}`}
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                setModelAnchor(null);
                setView("settings");
              }}
            >
              Manage models…
            </MenuItem>
          </Menu>
          <Tooltip title="Task history">
            <IconButton
              size="small"
              onClick={() => setView("history")}
              aria-label="Task history"
            >
              <HistoryOutlinedIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Settings">
            <IconButton
              size="small"
              onClick={() => setView("settings")}
              aria-label="Settings"
            >
              <SettingsOutlinedIcon />
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
              icon={<FiberManualRecordIcon />}
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
              Ask BrowserCrew to read, navigate, compare, fill, or work across tabs.
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
                  <Typography variant="body2">{message.text}</Typography>
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
                  <Tooltip title="Attach/context — next MVP slice">
                    <span>
                      <IconButton size="small" disabled>
                        <AddIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
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
                      <FiberManualRecordIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <IconButton
                    size="small"
                    color="primary"
                    onClick={() => void runTask()}
                    disabled={!prompt.trim() || running || recording}
                    aria-label="Send"
                  >
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
