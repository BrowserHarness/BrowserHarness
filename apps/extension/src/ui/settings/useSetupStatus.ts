import { useEffect, useState } from "react";
import { loadActiveConnection } from "../../settings/provider-store";
import { BRIDGE_STATUS_KEY, loadBridgeSettings, loadBridgeStatus, type BridgeStatus } from "../../settings/bridge-store";
import { DEFAULT_PREFERENCES, loadPreferences, PREFERENCES_STORAGE_KEY, type UserPreferences } from "../../settings/preferences";
import { loadAboutMe } from "../../runtime/about-me";
import { loadInstructions } from "../../runtime/instructions";
import { loadSkills } from "../../runtime/skills";
import { loadSchedules } from "../../runtime/schedules";

export interface SetupStatus {
  loaded: boolean;
  /** The AI doing the work, or null when none is connected. */
  ai: { name: string; canUseBrowser: boolean } | null;
  preferences: UserPreferences;
  facts: number;
  hasInstructions: boolean;
  skills: number;
  schedules: number;
  helperPaired: boolean;
  helper: BridgeStatus["state"];
  chatApps: string[];
}

const EMPTY: SetupStatus = {
  loaded: false,
  ai: null,
  preferences: DEFAULT_PREFERENCES,
  facts: 0,
  hasInstructions: false,
  skills: 0,
  schedules: 0,
  helperPaired: false,
  helper: "disabled",
  chatApps: []
};

/** Everything the Start page shows, kept up to date while it is open. */
export function useSetupStatus(): SetupStatus {
  const [status, setStatus] = useState<SetupStatus>(EMPTY);
  useEffect(() => {
    const load = async () => {
      const [active, preferences, facts, instructions, skills, schedules, bridge, settings] = await Promise.all([
        loadActiveConnection().catch(() => null),
        loadPreferences(),
        loadAboutMe().catch(() => []),
        loadInstructions().catch(() => ""),
        loadSkills().catch(() => []),
        loadSchedules().catch(() => []),
        loadBridgeStatus().catch(() => ({ state: "disabled" }) as BridgeStatus),
        loadBridgeSettings().catch(() => null)
      ]);
      setStatus({
        loaded: true,
        ai:
          active && active.chatHealth.status === "healthy"
            ? { name: active.model || active.label, canUseBrowser: active.agentHealth.status === "healthy" }
            : null,
        preferences,
        facts: facts.length,
        hasInstructions: Boolean(instructions.trim()),
        skills: skills.length,
        schedules: schedules.filter((item) => item.enabled).length,
        helperPaired: Boolean(settings?.enabled && settings.token),
        helper: bridge.state,
        chatApps: bridge.state === "connected" ? bridge.chat_apps || [] : []
      });
    };
    void load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[BRIDGE_STATUS_KEY]) void load();
      if (area === "local" && Object.keys(changes).some((key) => key.startsWith("browserharness."))) void load();
      if (area === "local" && changes[PREFERENCES_STORAGE_KEY]) void load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return status;
}
