import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Typography
} from "@mui/material";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  updatePreferences,
  type AppearanceMode,
  type UserPreferences
} from "../settings/preferences";
import { clearTaskHistory } from "../runtime/history";
import { BridgeSettingsSection } from "./BridgeSettingsSection";

export function MvpSettingsSections() {
  const [preferences, setPreferences] =
    useState<UserPreferences>(DEFAULT_PREFERENCES);
  useEffect(() => {
    void loadPreferences().then(setPreferences);
  }, []);

  const setAppearance = async (appearance: AppearanceMode) => {
    const next = await updatePreferences({ appearance });
    setPreferences(next);
  };

  const setHistoryRetention = async (retainTaskHistory: boolean) => {
    const next = await updatePreferences({ retainTaskHistory });
    setPreferences(next);
    if (!retainTaskHistory) {
      await clearTaskHistory();
    }
  };


  return (
    <Stack spacing={2.5}>
      <BridgeSettingsSection />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle1">Browser Access</Typography>
          <Alert severity="success">
            Full browser-agent access is enabled for this BrowserHarness build.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            BrowserHarness can work across websites, tabs and windows; inspect navigation
            and network activity; use Chrome DevTools Protocol for trusted input and
            accessibility-tree targeting; upload files supplied to the agent runtime;
            and export pages as PDF.
          </Typography>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle1">Permissions</Typography>
          <Alert severity="info">
            Consequential actions such as send, submit, purchase, delete, or
            account/security changes always require an explicit approval in the MVP.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            This safety gate is not user-disableable in v0.1.
          </Typography>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle1">Privacy</Typography>
          <FormControlLabel
            control={
              <Switch
                checked={preferences.retainTaskHistory}
                onChange={(event) =>
                  void setHistoryRetention(event.target.checked)
                }
              />
            }
            label="Keep completed task history on this device"
          />
          <Typography variant="body2" color="text.secondary">
            Provider keys, task history, workflows, and preferences are stored in
            Chrome extension local storage. BrowserHarness does not send them to a
            BrowserHarness cloud service in v0.1.
          </Typography>
          <Button
            variant="outlined"
            onClick={() => void clearTaskHistory()}
          >
            Clear local task history now
          </Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle1">Appearance</Typography>
          <FormControl fullWidth>
            <InputLabel id="appearance-mode-label">Theme</InputLabel>
            <Select
              labelId="appearance-mode-label"
              label="Theme"
              value={preferences.appearance}
              onChange={(event) =>
                void setAppearance(event.target.value as AppearanceMode)
              }
            >
              <MenuItem value="system">System</MenuItem>
              <MenuItem value="light">Light</MenuItem>
              <MenuItem value="dark">Dark</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Paper>
    </Stack>
  );
}
