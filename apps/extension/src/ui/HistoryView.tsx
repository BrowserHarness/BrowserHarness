import { useEffect, useState } from "react";
import { BackIcon, ClearAllIcon } from "./icons";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from "@mui/material";
import { ScheduledView } from "./ScheduledView";
import {
  clearTaskHistory,
  loadTaskHistory,
  searchTaskHistory,
  type TaskHistoryEntry
} from "../runtime/history";

export function HistoryView({
  onBack,
  onRunAgain,
  initialTab = "past"
}: {
  onBack: () => void;
  onRunAgain?: (task: string) => void;
  initialTab?: "past" | "scheduled";
}) {
  const [tab, setTab] = useState(initialTab);
  const [entries, setEntries] = useState<TaskHistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const shown = searchTaskHistory(entries, query);

  const refresh = async () => {
    setEntries(await loadTaskHistory());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    await clearTaskHistory();
    await refresh();
  };

  return (
    <Box sx={{ minHeight: "100vh", p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={onBack} aria-label="Back to chat">
          <BackIcon />
        </IconButton>
        <Typography variant="h6" sx={{ flex: 1 }}>
          Task history
        </Typography>
        {tab === "past" && (
          <IconButton
            aria-label="Clear task history"
            onClick={() => void clear()}
            disabled={entries.length === 0}
          >
            <ClearAllIcon />
          </IconButton>
        )}
      </Stack>

      <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ mb: 2, minHeight: 36 }}>
        <Tab value="past" label="Past tasks" sx={{ minHeight: 36 }} />
        <Tab value="scheduled" label="Scheduled" sx={{ minHeight: 36 }} />
      </Tabs>

      {tab === "scheduled" ? (
        <ScheduledView />
      ) : (
      <>
      {entries.length > 0 && (
        <TextField
          fullWidth
          size="small"
          label="Search past tasks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          sx={{ mb: 2 }}
        />
      )}

      {entries.length === 0 ? (
        <Alert severity="info">
          No local task history yet. BrowserHarness keeps up to 500 completed tasks on this device.
        </Alert>
      ) : shown.length === 0 ? (
        <Alert severity="info">No past task matches “{query}”.</Alert>
      ) : (
        <Stack spacing={1.5}>
          {shown.map((entry) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} key={entry.id}>
              <Stack spacing={0.75}>
                <Typography variant="subtitle2">{entry.task}</Typography>
                <Typography variant="body2">{entry.result}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(entry.timestamp).toLocaleString()}
                  {entry.url ? ` · ${entry.url}` : ""}
                </Typography>
                {onRunAgain && (
                  <Box>
                    <Button size="small" onClick={() => onRunAgain(entry.task)}>
                      Run again
                    </Button>
                  </Box>
                )}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      </>
      )}

      <Button sx={{ mt: 2 }} onClick={onBack}>
        Back to chat
      </Button>
    </Box>
  );
}
