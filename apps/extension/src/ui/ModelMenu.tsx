import { useMemo, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Popover,
  TextField,
  Typography
} from "@mui/material";
import {
  connectionIdFor,
  loadConnections,
  type CapabilityHealth,
  type ProviderConnection
} from "../settings/provider-store";
import {
  accountIdFor,
  accountLabel,
  chooseModel,
  listAccountModels,
  loadAccounts,
  type AccountModel,
  type ProviderAccount
} from "../settings/account-store";
import { CheckIcon, ChevronDownIcon } from "./icons";

interface AccountRow {
  account: ProviderAccount;
  models: AccountModel[];
  error?: string;
}

/** Most a single service shows before the user narrows it with search. */
const MAX_ROWS_PER_SERVICE = 60;

export function shortModelName(model: string): string {
  const tail = model.split("/").pop() || model;
  return tail.length > 28 ? `${tail.slice(0, 26)}…` : tail;
}

export function filterModels(models: AccountModel[], query: string): AccountModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((model) =>
    words.every((word) => model.id.toLowerCase().includes(word))
  );
}

/** What is known about a model driving the browser, from real checks or tasks. */
export function browserLabel(health: CapabilityHealth | undefined): string | undefined {
  if (health?.status === "healthy") return "✓ Browser-ready";
  if (health?.status === "failed") return "Chat only: failed the browser check";
  return undefined;
}

/**
 * The model menu at the top of the chat: every model from every connected
 * service, searchable, one click to switch (like claude.ai or chatgpt.com).
 */
export function ModelMenu({
  current,
  onChanged,
  onManage
}: {
  current: ProviderConnection | null;
  onChanged: () => void | Promise<void>;
  onManage: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState("");
  const [health, setHealth] = useState<Record<string, CapabilityHealth>>({});

  const load = async () => {
    setRows(null);
    const known = await loadConnections().catch(() => []);
    setHealth(Object.fromEntries(known.map((item) => [item.id, item.agentHealth])));
    const accounts = await loadAccounts();
    setRows(
      await Promise.all(
        accounts.map(async (account): Promise<AccountRow> => {
          try {
            return { account, models: await listAccountModels(account) };
          } catch (error) {
            return {
              account,
              models: [],
              error: error instanceof Error ? error.message : "Could not load models"
            };
          }
        })
      )
    );
  };

  const open = (target: HTMLElement) => {
    setAnchor(target);
    setQuery("");
    void load();
  };

  const currentAccount = current
    ? accountIdFor(current.provider, current.baseUrl)
    : "";

  const pick = async (account: ProviderAccount, model: string) => {
    setSwitching(`${account.id}|${model}`);
    try {
      await chooseModel(account, model);
      await onChanged();
      setAnchor(null);
    } finally {
      setSwitching("");
    }
  };

  const visible = useMemo(
    () =>
      (rows || []).map((row) => ({
        ...row,
        models: filterModels(row.models, query)
      })),
    [rows, query]
  );

  return (
    <>
      <Button
        size="small"
        onClick={(event) => open(event.currentTarget)}
        endIcon={<ChevronDownIcon fontSize="small" />}
        aria-label="Choose model"
        title={
          current?.agentHealth.status === "healthy"
            ? `${current.model}: browser-ready`
            : current?.model
        }
        sx={{ maxWidth: 180, textTransform: "none" }}
      >
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.model ? shortModelName(current.model) : "Connect AI"}
        </Box>
      </Button>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 320, maxHeight: 460, display: "flex", flexDirection: "column" } } }}
      >
        <Box sx={{ p: 1.5, pb: 1 }}>
          <TextField
            size="small"
            fullWidth
            autoFocus
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            inputProps={{ "aria-label": "Search models" }}
          />
        </Box>
        <Box sx={{ overflowY: "auto", flex: 1 }}>
          {rows === null ? (
            <Box sx={{ display: "flex", gap: 1, alignItems: "center", p: 2 }}>
              <CircularProgress size={16} />
              <Typography variant="body2">Loading your models…</Typography>
            </Box>
          ) : rows.length === 0 ? (
            <Typography variant="body2" sx={{ p: 2 }}>
              No service connected yet.
            </Typography>
          ) : (
            <List dense disablePadding>
              {visible.map((row) => (
                <Box key={row.account.id} component="li" sx={{ listStyle: "none" }}>
                  <List dense disablePadding>
                    <ListSubheader sx={{ lineHeight: "32px" }}>
                      {accountLabel(row.account)}
                    </ListSubheader>
                    {row.error && (
                      <Typography variant="caption" color="error" sx={{ px: 2, display: "block" }}>
                        {row.error}
                      </Typography>
                    )}
                    {!row.error && row.models.length === 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ px: 2, display: "block" }}>
                        {query ? "No match" : "No models available"}
                      </Typography>
                    )}
                    {row.models.slice(0, MAX_ROWS_PER_SERVICE).map((model) => {
                      const selected =
                        currentAccount === row.account.id && current?.model === model.id;
                      const key = `${row.account.id}|${model.id}`;
                      return (
                        <ListItemButton
                          key={key}
                          selected={selected}
                          disabled={Boolean(switching)}
                          onClick={() => void pick(row.account, model.id)}
                        >
                          <ListItemIcon sx={{ minWidth: 28 }}>
                            {switching === key ? (
                              <CircularProgress size={14} />
                            ) : selected ? (
                              <CheckIcon fontSize="small" />
                            ) : null}
                          </ListItemIcon>
                          <ListItemText
                            primary={model.id}
                            primaryTypographyProps={{ noWrap: true, title: model.id }}
                            secondary={browserLabel(
                              health[
                                connectionIdFor({
                                  provider: row.account.provider,
                                  baseUrl: row.account.baseUrl,
                                  model: model.id
                                })
                              ]
                            )}
                          />
                        </ListItemButton>
                      );
                    })}
                    {row.models.length > MAX_ROWS_PER_SERVICE && (
                      <Typography variant="caption" color="text.secondary" sx={{ px: 2, display: "block" }}>
                        {`${row.models.length - MAX_ROWS_PER_SERVICE} more: type to search`}
                      </Typography>
                    )}
                  </List>
                </Box>
              ))}
            </List>
          )}
        </Box>
        <Divider />
        <ListItemButton
          onClick={() => {
            setAnchor(null);
            onManage();
          }}
        >
          <ListItemText primary="Add or manage services…" />
        </ListItemButton>
      </Popover>
    </>
  );
}
