import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography
} from "@mui/material";
import {
  BRIDGE_STATUS_KEY,
  DEFAULT_BRIDGE_SETTINGS,
  loadBridgeSettings,
  loadBridgeStatus,
  saveBridgeSettings,
  type BridgeStatus
} from "../settings/bridge-store";
import {
  BridgeNotRunningError,
  requestPairing,
  waitForPairing
} from "../settings/bridge-pairing";

type Step =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "code"; code: string }
  | { kind: "not-running" }
  | { kind: "error"; message: string };

function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * Lets Claude Code, Codex, Cursor or Hermes on this computer use the browser:
 * install the Bridge once, press Pair, type the code shown here into the
 * terminal.
 */
export function CodingAgentsCard() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const cancel = useRef<AbortController | null>(null);

  useEffect(() => {
    void loadBridgeStatus().then(setStatus);
    void loadBridgeSettings().then((settings) => setEnabled(settings.enabled));
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName === "session" && changes[BRIDGE_STATUS_KEY]?.newValue) {
        setStatus(changes[BRIDGE_STATUS_KEY].newValue as BridgeStatus);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      cancel.current?.abort();
    };
  }, []);

  const connected = enabled && status?.state === "connected";

  const pair = async () => {
    cancel.current?.abort();
    const controller = new AbortController();
    cancel.current = controller;
    setStep({ kind: "asking" });
    try {
      const settings = await loadBridgeSettings();
      const address = settings.address || DEFAULT_BRIDGE_SETTINGS.address;
      const request = await requestPairing(address);
      setStep({ kind: "code", code: request.code });
      const token = await waitForPairing(address, request.request_id, {
        signal: controller.signal
      });
      await saveBridgeSettings({ ...settings, address, enabled: true, token });
      setEnabled(true);
      setStep({ kind: "idle" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStep(
        error instanceof BridgeNotRunningError
          ? { kind: "not-running" }
          : {
              kind: "error",
              message: error instanceof Error ? error.message : "Pairing failed."
            }
      );
    }
  };

  const stopPairing = () => {
    cancel.current?.abort();
    setStep({ kind: "idle" });
  };

  const disconnect = async () => {
    const settings = await loadBridgeSettings();
    await saveBridgeSettings({ ...settings, enabled: false });
    setEnabled(false);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.25}>
        <Typography variant="subtitle1">Coding agents</Typography>
        <Typography variant="body2" color="text.secondary">
          Let Claude Code, Codex, Cursor or Hermes on this computer use this
          browser for you. Approvals and your own tabs stay protected.
        </Typography>

        {connected ? (
          <>
            <Alert severity="success">
              Connected. Ask your coding agent to use BrowserHarness, or type
              /browserharness in it.
            </Alert>
            <Box>
              <Button size="small" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Typography variant="body2">
              1. Install the BrowserHarness Bridge once: run install.sh (Mac,
              Linux) or install.cmd (Windows) from the Bridge download. It sets
              up the agents it finds.
            </Typography>
            <Typography variant="body2">
              2. Press Pair, then type the code shown here into the terminal.
            </Typography>

            {step.kind === "code" ? (
              <Stack spacing={1} alignItems="flex-start">
                <Typography
                  aria-label="Pairing code"
                  sx={{ fontSize: 30, fontWeight: 600, letterSpacing: 4 }}
                >
                  {spacedCode(step.code)}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="text.secondary">
                    Waiting for you to type this code in the terminal…
                  </Typography>
                </Stack>
                <Button size="small" onClick={stopPairing}>
                  Cancel
                </Button>
              </Stack>
            ) : (
              <Box>
                <Button
                  variant="contained"
                  onClick={() => void pair()}
                  disabled={step.kind === "asking"}
                >
                  Pair
                </Button>
              </Box>
            )}

            {step.kind === "not-running" && (
              <Alert severity="warning">
                The Bridge isn't running on this computer yet. Run the
                installer from step 1, then press Pair again.
              </Alert>
            )}
            {step.kind === "error" && <Alert severity="error">{step.message}</Alert>}
            {enabled && status?.state !== "connected" && step.kind === "idle" && (
              <Alert severity="info">
                Paired, but the Bridge is not reachable right now
                {status?.message ? ` (${status.message})` : ""}. It reconnects
                on its own when the Bridge runs.
              </Alert>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}
