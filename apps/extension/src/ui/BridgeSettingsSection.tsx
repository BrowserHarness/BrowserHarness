import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography
} from "@mui/material";
import { ensureEndpointAccess } from "../settings/browser-access";
import {
  getMcpServerTrustMode,
  setMcpServerTrustMode,
  type McpServerTrustMode
} from "../settings/mcp-trust-store";
import {
  bridgePermissionUrl,
  BRIDGE_STATUS_KEY,
  DEFAULT_BRIDGE_SETTINGS,
  loadBridgeSettings,
  loadBridgeStatus,
  saveBridgeSettings,
  type BridgeSettings,
  type BridgeStatus
} from "../settings/bridge-store";

interface MappedMcpServer {
  id: string;
  label: string;
  enabled: boolean;
  transport: string;
  connected: boolean;
  env_keys: string[];
}

interface MappedMcpTool {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

async function mcpBrowserTool<T>(
  input: Record<string, unknown>
): Promise<{
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}> {
  return chrome.runtime.sendMessage({
    type: "BROWSER_TOOL",
    tool: "mcp",
    input
  });
}

export function BridgeSettingsSection() {
  const [settings, setSettings] =
    useState<BridgeSettings>(DEFAULT_BRIDGE_SETTINGS);
  const [status, setStatus] = useState<BridgeStatus>({
    state: "disabled",
    changed_at: new Date().toISOString()
  });
  const [message, setMessage] = useState("");
  const [mcpServers, setMcpServers] = useState<
    MappedMcpServer[]
  >([]);
  const [mcpTrust, setMcpTrust] = useState<
    Record<string, McpServerTrustMode>
  >({});
  const [mcpTools, setMcpTools] = useState<
    Record<string, MappedMcpTool[]>
  >({});
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpMessage, setMcpMessage] = useState("");

  useEffect(() => {
    void loadBridgeSettings().then(setSettings);
    void loadBridgeStatus().then(setStatus);

    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (
        areaName === "session" &&
        changes[BRIDGE_STATUS_KEY]?.newValue
      ) {
        setStatus(changes[BRIDGE_STATUS_KEY].newValue);
      }
    };

    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  useEffect(() => {
    if (status.state === "connected") {
      void refreshMcpServers();
    } else {
      setMcpServers([]);
      setMcpTools({});
    }
  }, [status.state]);

  const refreshMcpServers = async () => {
    setMcpLoading(true);
    setMcpMessage("");
    try {
      const result = await mcpBrowserTool<{
        servers: MappedMcpServer[];
      }>({ action: "servers" });

      if (!result.ok || !result.data) {
        setMcpServers([]);
        setMcpMessage(
          result.error?.message ||
            "Could not load external MCP servers."
        );
        return;
      }

      const servers = result.data.servers || [];
      setMcpServers(servers);
      const trustEntries = await Promise.all(
        servers.map(async (server) => [
          server.id,
          await getMcpServerTrustMode(server.id)
        ] as const)
      );
      setMcpTrust(Object.fromEntries(trustEntries));
    } finally {
      setMcpLoading(false);
    }
  };

  const loadMcpTools = async (serverId: string) => {
    setMcpMessage("");
    const result = await mcpBrowserTool<{
      tools: MappedMcpTool[];
    }>({
      action: "list_tools",
      server_id: serverId
    });

    if (!result.ok || !result.data) {
      setMcpMessage(
        result.error?.message ||
          "Could not discover MCP tools."
      );
      return;
    }

    setMcpTools((current) => ({
      ...current,
      [serverId]: result.data?.tools || []
    }));
  };

  const updateMcpTrust = async (
    serverId: string,
    mode: McpServerTrustMode
  ) => {
    await setMcpServerTrustMode(serverId, mode);
    setMcpTrust((current) => ({
      ...current,
      [serverId]: mode
    }));
  };

  const save = async () => {
    try {
      if (settings.enabled) {
        const granted = await ensureEndpointAccess(
          bridgePermissionUrl(settings.address)
        );
        if (!granted) {
          setMessage(
            "Chrome did not grant access to the bridge address."
          );
          return;
        }
      }

      await saveBridgeSettings(settings);
      setMessage(
        settings.enabled
          ? "Bridge settings saved. BrowserHarness will connect to the local daemon."
          : "Local Agent Bridge disabled."
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save bridge settings."
      );
    }
  };

  const severity =
    status.state === "connected"
      ? "success"
      : status.state === "error"
        ? "error"
        : "info";

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1">
          Local Agent Bridge: address and token
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Manual Bridge settings. Most people only need Pair under Coding
          agents above. It is loopback-only by default; a remote Bridge on your own server is also possible over wss:// with a long pairing token.
          BrowserHarness task sessions, semantic refs and approval policy still apply.
        </Typography>

        <FormControlLabel
          control={
            <Switch
              checked={settings.enabled}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  enabled: event.target.checked
                }))
              }
            />
          }
          label="Enable local agent remote control"
        />

        <TextField
          label="Bridge address"
          value={settings.address}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              address: event.target.value
            }))
          }
          placeholder="ws://127.0.0.1:10087/ws or wss://bridge.example.com/ws"
          fullWidth
        />

        <TextField
          label="Pairing token"
          value={settings.token}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              token: event.target.value
            }))
          }
          type="password"
          autoComplete="off"
          fullWidth
          helperText="Generated by the local BrowserHarness Bridge daemon. Stored only in extension-local storage."
        />

        <Alert severity={severity}>
          Bridge: {status.state}
          {status.message ? ` · ${status.message}` : ""}
        </Alert>

        {message && <Alert severity="info">{message}</Alert>}

        <Button variant="outlined" onClick={() => void save()}>
          Save bridge settings
        </Button>

        <Stack spacing={1.25}>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            gap={1}
          >
            <Box>
              <Typography variant="subtitle2">
                External MCP servers
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
              >
                Configured by the local Bridge daemon. Secret values stay
                outside Chrome.
              </Typography>
            </Box>
            <Button
              size="small"
              variant="text"
              disabled={
                status.state !== "connected" || mcpLoading
              }
              onClick={() => void refreshMcpServers()}
            >
              {mcpLoading ? (
                <CircularProgress size={16} />
              ) : (
                "Refresh"
              )}
            </Button>
          </Stack>

          {status.state === "connected" &&
            !mcpLoading &&
            mcpServers.length === 0 && (
              <Alert severity="info">
                No external MCP servers are configured in the Bridge daemon.
              </Alert>
            )}

          {mcpMessage && (
            <Alert severity="warning">{mcpMessage}</Alert>
          )}

          {mcpServers.map((server) => {
            const tools = mcpTools[server.id];
            const mode =
              mcpTrust[server.id] || "allow-read-only";

            return (
              <Paper
                variant="outlined"
                sx={{ p: 1.5 }}
                key={server.id}
              >
                <Stack spacing={1.25}>
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="flex-start"
                    gap={1}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="subtitle2"
                        noWrap
                      >
                        {server.label}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                      >
                        {server.id} · {server.transport}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      color={
                        server.connected
                          ? "success"
                          : server.enabled
                            ? "default"
                            : "warning"
                      }
                      label={
                        server.connected
                          ? "Connected"
                          : server.enabled
                            ? "Configured"
                            : "Disabled"
                      }
                    />
                  </Stack>

                  {server.env_keys.length > 0 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                    >
                      Environment keys:{" "}
                      {server.env_keys.join(", ")}
                    </Typography>
                  )}

                  <FormControl size="small" fullWidth>
                    <InputLabel
                      id={`mcp-trust-${server.id}`}
                    >
                      BrowserHarness policy
                    </InputLabel>
                    <Select
                      labelId={`mcp-trust-${server.id}`}
                      label="BrowserHarness policy"
                      value={mode}
                      onChange={(event) =>
                        void updateMcpTrust(
                          server.id,
                          event.target
                            .value as McpServerTrustMode
                        )
                      }
                    >
                      <MenuItem value="allow-read-only">
                        Allow read-only · ask before writes
                      </MenuItem>
                      <MenuItem value="ask-all">
                        Ask before every tool
                      </MenuItem>
                      <MenuItem value="blocked">
                        Block this server
                      </MenuItem>
                    </Select>
                  </FormControl>

                  <Button
                    size="small"
                    variant="outlined"
                    disabled={!server.enabled}
                    onClick={() =>
                      void loadMcpTools(server.id)
                    }
                  >
                    {tools
                      ? "Refresh tools"
                      : "Discover tools"}
                  </Button>

                  {tools && (
                    <Stack spacing={0.75}>
                      {tools.length === 0 ? (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                        >
                          This server exposed no tools.
                        </Typography>
                      ) : (
                        tools.map((tool) => (
                          <Box key={tool.name}>
                            <Stack
                              direction="row"
                              gap={0.75}
                              alignItems="center"
                              flexWrap="wrap"
                            >
                              <Typography
                                variant="body2"
                                sx={{ fontWeight: 600 }}
                              >
                                {tool.name}
                              </Typography>
                              <Chip
                                size="small"
                                variant="outlined"
                                label={
                                  tool.annotations
                                    ?.readOnlyHint ===
                                    true &&
                                  tool.annotations
                                    ?.destructiveHint !==
                                    true
                                    ? "Read-only"
                                    : "Approval required"
                                }
                              />
                            </Stack>
                            {tool.description && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {tool.description}
                              </Typography>
                            )}
                          </Box>
                        ))
                      )}
                    </Stack>
                  )}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Stack>
    </Paper>
  );
}
