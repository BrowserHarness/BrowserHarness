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
  hasAllSitesAccess,
  requestAllSitesAccess,
  revokeAllSitesAccess
} from "../settings/browser-access";
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
  const [allSites, setAllSites] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");

  const refreshAccess = async () => {
    setAllSites(await hasAllSitesAccess());
  };

  useEffect(() => {
    void loadPreferences().then(setPreferences);
    void refreshAccess();
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

  const enableAllSites = async () => {
    const granted = await requestAllSitesAccess();
    await refreshAccess();
    setAccessMessage(
      granted
        ? "BrowserCrew can now operate across websites and tabs."
        : "Chrome did not grant all-sites access."
    );
  };

  const disableAllSites = async () => {
    const removed = await revokeAllSitesAccess();
    await refreshAccess();
    setAccessMessage(
      removed
        ? "All-sites access was removed. Current-tab access can still work through Chrome's active-tab permission."
        : "Chrome did not change the current site-access grant."
    );
  };

  return (
    <Stack spacing={2.5}>
      <BridgeSettingsSection />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle1">Browser Access</Typography>
          <Typography variant="body2" color="text.secondary">
            BrowserCrew uses Chrome's active-tab permission for the tab you invoke it on.
            Grant all-sites access only when you want multi-tab or cross-site automation.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={allSites}
                onChange={() =>
                  void (allSites ? disableAllSites() : enableAllSites())
                }
              />
            }
            label="Allow BrowserCrew on all websites"
          />

          {accessMessage && (
            <Alert severity={allSites ? "success" : "info"}>
              {accessMessage}
            </Alert>
          )}
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
            Chrome extension local storage. BrowserCrew does not send them to a
            BrowserCrew cloud service in v0.1.
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
