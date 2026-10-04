import { useEffect, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  Typography
} from "@mui/material";
import {
  clearTaskHistory,
  loadTaskHistory,
  type TaskHistoryEntry
} from "../runtime/history";

export function HistoryView({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>([]);

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
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6" sx={{ flex: 1 }}>
          Task history
        </Typography>
        <IconButton
          aria-label="Clear task history"
          onClick={() => void clear()}
          disabled={entries.length === 0}
        >
          <DeleteSweepOutlinedIcon />
        </IconButton>
      </Stack>

      {entries.length === 0 ? (
        <Alert severity="info">
          No local task history yet. BrowserHarness keeps up to 50 completed tasks on this device.
        </Alert>
      ) : (
        <Stack spacing={1.5}>
          {entries.map((entry) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} key={entry.id}>
              <Stack spacing={0.75}>
                <Typography variant="subtitle2">{entry.task}</Typography>
                <Typography variant="body2">{entry.result}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(entry.timestamp).toLocaleString()}
                  {entry.url ? ` · ${entry.url}` : ""}
                </Typography>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Button sx={{ mt: 2 }} onClick={onBack}>
        Back to chat
      </Button>
    </Box>
  );
}
