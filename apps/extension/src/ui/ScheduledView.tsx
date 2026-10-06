import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { DeleteIcon, RunIcon } from "./icons";
import { Note, PageTitle, SettingsCard, useConfirm } from "./kit";
import { BRIDGE_STATUS_KEY, loadBridgeStatus } from "../settings/bridge-store";
import {
  CHAT_APP_LABELS,
  deleteScheduledTask,
  describeSchedule,
  isChatApp,
  setScheduleDelivery,
  type ChatApp,
  loadSchedules,
  MIN_INTERVAL_MINUTES,
  newScheduledTask,
  saveScheduledTask,
  SCHEDULES_STORAGE_KEY,
  setScheduleEnabled,
  type Schedule,
  type ScheduledTask
} from "../runtime/schedules";

type When = "daily" | "weekdays" | "weekly" | "hours" | "once";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function scheduleFrom(when: When, time: string, day: number, hours: number, at: string): Schedule | null {
  switch (when) {
    case "daily":
      return { kind: "daily", time, days: [0, 1, 2, 3, 4, 5, 6] };
    case "weekdays":
      return { kind: "daily", time, days: [1, 2, 3, 4, 5] };
    case "weekly":
      return { kind: "daily", time, days: [day] };
    case "hours":
      return hours > 0 ? { kind: "interval", minutes: Math.max(MIN_INTERVAL_MINUTES, Math.round(hours * 60)) } : null;
    default: {
      const date = new Date(at);
      return Number.isNaN(date.getTime()) ? null : { kind: "once", at: date.toISOString() };
    }
  }
}

const STATUS_COLOR = { worked: "success", failed: "error", "needs you": "warning" } as const;
const STATUS_LABEL = { worked: "Worked", failed: "Didn't work", "needs you": "Needs you" } as const;

export function ScheduledView({ embedded }: { embedded?: boolean } = {}) {
  const [dialog, confirm] = useConfirm();
  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [task, setTask] = useState("");
  const [when, setWhen] = useState<When>("weekdays");
  const [time, setTime] = useState("08:00");
  const [day, setDay] = useState(1);
  const [hours, setHours] = useState(2);
  const [at, setAt] = useState("");
  const [error, setError] = useState("");
  const [deliverTo, setDeliverTo] = useState<ChatApp | "">("");
  const [chatApps, setChatApps] = useState<ChatApp[]>([]);

  const refresh = async () => setItems(await loadSchedules());
  const refreshChatApps = async () => setChatApps(((await loadBridgeStatus()).chat_apps || []).filter(isChatApp));

  useEffect(() => {
    void refresh();
    void refreshChatApps();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[SCHEDULES_STORAGE_KEY]) void refresh();
      if (area === "session" && changes[BRIDGE_STATUS_KEY]) void refreshChatApps();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const add = async () => {
    const schedule = scheduleFrom(when, time, day, hours, at);
    if (!task.trim()) return;
    const item = schedule ? { ...newScheduledTask(task, schedule), deliver_to: deliverTo || undefined } : null;
    if (!item?.next_run_at) {
      setError("Pick a time in the future.");
      return;
    }
    setError("");
    await saveScheduledTask(item);
    setTask("");
    await refresh();
  };

  const intro = (
    <>
      BrowserHarness runs these by itself while Chrome is open, each in its own background tab, and tells you when they
      finish. Anything that needs your OK waits for you. You can also type <code>/schedule every weekday at 8am …</code>{" "}
      in the chat.
    </>
  );

  return (
    <Box>
      {dialog}
      {embedded ? (
        <PageTitle title="Scheduled tasks" intro={intro} />
      ) : (
        <Typography variant="body2" color="text.secondary" mb={1.5}>
          {intro}
        </Typography>
      )}
      <Box mb={2.5}>
      <SettingsCard title={embedded ? "Add a scheduled task" : undefined}>
        <Stack spacing={1.5}>
          <TextField
            size="small"
            label="What should it do?"
            placeholder="Check my inbox and list new invoices, or /a-skill"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            multiline
            maxRows={4}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField
              select
              size="small"
              label="When"
              value={when}
              onChange={(event) => setWhen(event.target.value as When)}
              sx={{ minWidth: 150 }}
            >
              <MenuItem value="daily">Every day</MenuItem>
              <MenuItem value="weekdays">Every weekday</MenuItem>
              <MenuItem value="weekly">Every week</MenuItem>
              <MenuItem value="hours">Every few hours</MenuItem>
              <MenuItem value="once">Once</MenuItem>
            </TextField>
            {when === "weekly" && (
              <TextField select size="small" label="On" value={day} onChange={(event) => setDay(Number(event.target.value))}>
                {DAYS.map((name, index) => (
                  <MenuItem key={name} value={index}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {(when === "daily" || when === "weekdays" || when === "weekly") && (
              <TextField size="small" type="time" label="At" value={time} onChange={(event) => setTime(event.target.value)} />
            )}
            {when === "hours" && (
              <TextField
                size="small"
                type="number"
                label="Every how many hours"
                helperText="1 to 24 hours"
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
                slotProps={{ htmlInput: { min: 1, max: 24 } }}
                sx={{ width: 170 }}
              />
            )}
            {when === "once" && (
              <TextField
                size="small"
                type="datetime-local"
                label="At"
                value={at}
                onChange={(event) => setAt(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            )}
          </Stack>
          {chatApps.length > 0 && (
            <TextField
              select
              size="small"
              label="Also send results to"
              value={deliverTo}
              onChange={(event) => setDeliverTo(event.target.value as ChatApp | "")}
              sx={{ maxWidth: 240 }}
            >
              <MenuItem value="">Only this computer</MenuItem>
              {chatApps.map((app) => (
                <MenuItem key={app} value={app}>
                  {CHAT_APP_LABELS[app]}
                </MenuItem>
              ))}
            </TextField>
          )}
          {error && <Note kind="warning">{error}</Note>}
          <Box>
            <Button variant="contained" disabled={!task.trim()} onClick={() => void add()}>
              Schedule it
            </Button>
          </Box>
        </Stack>
      </SettingsCard>
      </Box>

      {items.length === 0 ? (
        <Note kind="info" title="Nothing scheduled yet">
          For example: “Every weekday at 8:00, check my inbox and list new invoices”.
        </Note>
      ) : (
        <Stack spacing={1.5}>
          {items.map((item) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} key={item.id} data-testid="scheduled-task">
              <Stack spacing={0.5}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="subtitle2" sx={{ flex: 1, wordBreak: "break-word" }}>
                    {item.task}
                  </Typography>
                  <Switch
                    size="small"
                    checked={item.enabled}
                    inputProps={{ "aria-label": `Turn ${item.enabled ? "off" : "on"} ${item.task}` }}
                    onChange={async (event) => {
                      await setScheduleEnabled(item.id, event.target.checked);
                      await refresh();
                    }}
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {describeSchedule(item.schedule)}
                  {item.enabled && item.next_run_at
                    ? ` · next ${new Date(item.next_run_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
                    : " · turned off"}
                  {item.deliver_to ? ` · results also go to ${CHAT_APP_LABELS[item.deliver_to]}` : ""}
                </Typography>
                {item.last_status && (
                  <Stack direction="row" spacing={1} alignItems="flex-start">
                    <Chip size="small" color={STATUS_COLOR[item.last_status]} label={STATUS_LABEL[item.last_status]} />
                    <Typography variant="body2" sx={{ flex: 1, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
                      {item.last_result}
                    </Typography>
                  </Stack>
                )}
                <Stack direction="row" spacing={0.5}>
                  <Button
                    size="small"
                    startIcon={<RunIcon fontSize="small" />}
                    onClick={() =>
                      void chrome.tabs.create({
                        url: chrome.runtime.getURL(`runner.html?schedule=${encodeURIComponent(item.id)}&keep=1`)
                      })
                    }
                  >
                    Run now
                  </Button>
                  {(chatApps.length > 0 || item.deliver_to) && (
                    <TextField
                      select
                      size="small"
                      variant="standard"
                      value={item.deliver_to || ""}
                      slotProps={{ htmlInput: { "aria-label": `Send results of ${item.task} to` } }}
                      onChange={async (event) => {
                        await setScheduleDelivery(item.id, isChatApp(event.target.value) ? event.target.value : undefined);
                        await refresh();
                      }}
                      sx={{ minWidth: 150, mx: 1 }}
                    >
                      <MenuItem value="">Only this computer</MenuItem>
                      {[...new Set([...chatApps, ...(item.deliver_to ? [item.deliver_to] : [])])].map((app) => (
                        <MenuItem key={app} value={app}>
                          Send to {CHAT_APP_LABELS[app]}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      aria-label={`Delete scheduled task ${item.task}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete this scheduled task?",
                          body: `“${item.task}” won't run again. To pause it instead, use its on/off switch.`,
                          confirmLabel: "Delete",
                          danger: true
                        });
                        if (!ok) return;
                        await deleteScheduledTask(item.id);
                        await refresh();
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
