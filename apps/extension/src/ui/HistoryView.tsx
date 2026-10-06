import { useEffect, useState } from "react";
import { Box, Button, Paper, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { Note, ScreenFrame, useConfirm } from "./kit";
import { ScheduledView } from "./ScheduledView";
import { SpaceNote } from "./spaces-ui";
import { clearTaskHistory, loadTaskHistory, searchTaskHistory, type TaskHistoryEntry } from "../runtime/history";

export function HistoryView({
  onBack,
  onRunAgain,
  initialTab = "past",
  embedded
}: {
  onBack: () => void;
  onRunAgain?: (task: string) => void;
  initialTab?: "past" | "scheduled";
  /** Inside Settings, where Scheduled tasks has its own page. */
  embedded?: boolean;
}) {
  const [tab, setTab] = useState(embedded ? "past" : initialTab);
  const [entries, setEntries] = useState<TaskHistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, confirm] = useConfirm();
  const shown = searchTaskHistory(entries, query);

  const refresh = async () => {
    setEntries(await loadTaskHistory());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    const ok = await confirm({
      title: "Delete your task history?",
      body: `All ${entries.length} past task${entries.length === 1 ? "" : "s"} and answers are deleted. Your Skills and settings stay. This can't be undone.`,
      confirmLabel: "Delete history",
      danger: true
    });
    if (!ok) return;
    await clearTaskHistory();
    await refresh();
  };

  const past = (
    <Stack spacing={2}>
      {entries.length > 0 && (
        <TextField
          fullWidth
          label="Search past tasks"
          placeholder="For example: kettle, flight, invoice"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {entries.length === 0 ? (
        <Note kind="info" title="Nothing here yet">
          Tasks you finish are listed here, so you can find them again or run them again. The last 500 are kept, on this
          computer only.
        </Note>
      ) : shown.length === 0 ? (
        <Note kind="info">No past task matches “{query}”.</Note>
      ) : (
        <Stack spacing={1.25}>
          {shown.map((entry) => (
            <Paper variant="outlined" sx={{ p: 1.75 }} key={entry.id}>
              <Stack spacing={0.75}>
                <Typography variant="subtitle2" fontSize="0.98rem">
                  {entry.task}
                </Typography>
                <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {entry.result}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                  {new Date(entry.timestamp).toLocaleString()}
                  {entry.url ? ` · ${entry.url}` : ""}
                </Typography>
                {onRunAgain && (
                  <Box>
                    <Button size="small" variant="outlined" onClick={() => onRunAgain(entry.task)}>
                      Run again
                    </Button>
                  </Box>
                )}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
      {entries.length > 0 && (
        <Box>
          <Button color="error" variant="outlined" aria-label="Clear task history" onClick={() => void clear()}>
            Delete all history
          </Button>
        </Box>
      )}
    </Stack>
  );

  return (
    <ScreenFrame
      title="Task history"
      embedded={embedded}
      onBack={onBack}
      intro={embedded ? "Everything you asked BrowserHarness to do, newest first. Kept on this computer only." : undefined}
    >
      {dialog}
      {!embedded && (
        <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ mb: 2, minHeight: 36 }}>
          <Tab value="past" label="Past tasks" sx={{ minHeight: 36 }} />
          <Tab value="scheduled" label="Scheduled" sx={{ minHeight: 36 }} />
        </Tabs>
      )}
      {tab === "scheduled" ? <ScheduledView /> : (
        <>
          <SpaceNote what="These are your past tasks" />
          {past}
        </>
      )}
    </ScreenFrame>
  );
}
