// Small shared pieces for Spaces and saved chats: the current Space, a
// coloured badge for it, a "type a name" dialog, and saving text to a file.
import { useEffect, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from "@mui/material";
import { defaultSpace, loadSpaces, SPACES_STORAGE_KEY, type Space } from "../runtime/spaces";

/** Every Space, and the one in use, kept up to date when another screen changes them. */
export function useSpaces(): { spaces: Space[]; active: Space; ready: boolean; refresh: () => Promise<void> } {
  const [state, setState] = useState<{ spaces: Space[]; active: Space; ready: boolean }>({
    spaces: [defaultSpace()],
    active: defaultSpace(),
    ready: false
  });
  const refresh = async () => {
    const next = await loadSpaces().catch(() => null);
    if (next) setState({ ...next, ready: true });
  };
  useEffect(() => {
    void refresh();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && SPACES_STORAGE_KEY in changes) void refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return { ...state, refresh };
}

/** A round coloured mark with the Space's first letter. */
export function SpaceBadge({ space, size = 22 }: { space: Pick<Space, "name" | "color">; size?: number }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: size / 3.2,
        bgcolor: space.color,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: size * 0.5,
        flexShrink: 0
      }}
    >
      {Array.from(space.name.trim())[0]?.toUpperCase() || "?"}
    </Box>
  );
}

/** Asks for a name (a new Space, a new chat title). Resolves with the text, or nothing. */
export function NameDialog({
  open,
  title,
  intro,
  label,
  initial = "",
  placeholder,
  confirmLabel,
  error,
  onClose,
  onSave
}: {
  open: boolean;
  title: string;
  intro?: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  error?: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSave(value);
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          {intro && (
            <Typography variant="body2" color="text.secondary" mb={2}>
              {intro}
            </Typography>
          )}
          <TextField
            autoFocus
            fullWidth
            label={label}
            placeholder={placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            error={Boolean(error)}
            helperText={error}
            sx={{ mt: intro ? 0 : 1 }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Saves text as a file in the person's Downloads folder. */
export function saveTextFile(text: string, fileName: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "These belong to Work": shown on screens whose contents differ per Space, once there is more than one. */
export function SpaceNote({ what }: { what: string }) {
  const { spaces, active } = useSpaces();
  if (spaces.length < 2) return null;
  return (
    <Box
      data-testid="space-note"
      sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2, px: 1.5, py: 1, borderRadius: 2, bgcolor: "action.hover" }}
    >
      <SpaceBadge space={active} size={20} />
      <Typography variant="body2">
        {what} in <strong>{active.name}</strong>. Your other Spaces keep their own.
      </Typography>
    </Box>
  );
}
