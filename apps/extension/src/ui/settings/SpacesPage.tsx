import { useEffect, useState } from "react";
import { Box, Button, ButtonBase, Paper, Stack, Typography } from "@mui/material";
import { Note, PageTitle, SettingsCard, useConfirm } from "../kit";
import { useSaved } from "../feedback";
import { AddIcon, CheckIcon, DeleteIcon, EditIcon, RestoreIcon, SaveFileIcon } from "../icons";
import { NameDialog, saveTextFile, SpaceBadge, useSpaces } from "../spaces-ui";
import {
  backupSpace,
  createSpace,
  DEFAULT_SPACE_ID,
  deleteSpace,
  loadSpaces,
  parseSpaceBackup,
  renameSpace,
  restoreSpace,
  setSpaceColor,
  SPACE_COLORS,
  switchSpace,
  type Space
} from "../../runtime/spaces";
import { chatFileName, loadChats } from "../../runtime/chats";
import type { SectionProps } from "./SettingsShell";

function ColorPicker({ space }: { space: Space }) {
  const saved = useSaved();
  return (
    <Stack direction="row" spacing={0.75} role="radiogroup" aria-label={`Colour for ${space.name}`}>
      {SPACE_COLORS.map((color) => (
        <ButtonBase
          key={color}
          role="radio"
          aria-checked={space.color === color}
          aria-label={`Colour ${SPACE_COLORS.indexOf(color) + 1}`}
          onClick={() => void setSpaceColor(space.id, color).then(() => saved("Colour changed"))}
          sx={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            bgcolor: color,
            color: "#fff",
            outline: space.color === color ? 2 : 0,
            outlineColor: "text.primary",
            outlineOffset: 2
          }}
        >
          {space.color === color && <CheckIcon fontSize="small" />}
        </ButtonBase>
      ))}
    </Stack>
  );
}

export function SpacesPage(_props: SectionProps) {
  const { spaces, active, refresh } = useSpaces();
  const [dialog, confirm] = useConfirm();
  const saved = useSaved();
  const [naming, setNaming] = useState<{ space?: Space } | null>(null);
  const [nameError, setNameError] = useState("");
  const [restoreNote, setRestoreNote] = useState<{ kind: "success" | "warning"; text: string } | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

  // How many chats each Space has, so people know what they are deleting.
  const countChats = async () => {
    const { spaces: all } = await loadSpaces();
    const pairs = await Promise.all(all.map(async (space) => [space.id, (await loadChats(space.id)).length] as const));
    setCounts(Object.fromEntries(pairs));
  };
  useEffect(() => {
    void countChats();
  }, [spaces.length]);

  const backup = async (space: Space) => {
    const file = await backupSpace(space.id);
    saveTextFile(JSON.stringify(file, null, 2), chatFileName(`browserharness-${space.name}-backup`, "json"), "application/json");
    saved(`Backup of ${space.name} saved to your Downloads folder`);
  };

  const remove = async (space: Space) => {
    const chats = counts[space.id] ?? 0;
    const first = space.id === DEFAULT_SPACE_ID;
    const ok = await confirm({
      title: first ? `Empty ${space.name}?` : `Delete ${space.name}?`,
      body: (
        <>
          {first
            ? `${space.name} is your first Space, so it stays, but everything in it is deleted: `
            : `${space.name} and everything in it are deleted: `}
          {chats} chat{chats === 1 ? "" : "s"}, its notes about you, its wishes and its task history. Your Skills, your AI
          and your other Spaces are not touched. This can't be undone.
          <Box mt={1.5}>Tip: press “Save a backup” first if you might want it back.</Box>
        </>
      ),
      confirmLabel: first ? "Empty it" : "Delete Space",
      danger: true
    });
    if (!ok) return;
    await deleteSpace(space.id);
    await refresh();
    await countChats();
    saved(first ? `${space.name} is now empty` : `${space.name} was deleted`);
  };

  return (
    <>
      {dialog}
      <PageTitle
        title="Spaces"
        intro="Keep different parts of your life apart, like Work, Home or a Family trip. Each Space has its own chats and its own notes about you, so nothing from one Space shows up in another."
      />
      <Stack spacing={2.5}>
        <SettingsCard
          title="Your Spaces"
          action={
            <Button
              variant="contained"
              startIcon={<AddIcon fontSize="small" />}
              onClick={() => {
                setNameError("");
                setNaming({});
              }}
            >
              New Space
            </Button>
          }
        >
          <Stack spacing={1.5}>
            {spaces.map((space) => (
              <Paper key={space.id} variant="outlined" sx={{ p: 2, borderColor: space.id === active.id ? "primary.main" : undefined }} data-testid="space-row">
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "flex-start", sm: "center" }}>
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                    <SpaceBadge space={space} size={36} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle1" noWrap>
                        {space.name}
                        {space.id === active.id && (
                          <Typography component="span" variant="caption" color="primary.main" fontWeight={600} ml={1}>
                            You're here
                          </Typography>
                        )}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {counts[space.id] === undefined ? "" : `${counts[space.id]} saved chat${counts[space.id] === 1 ? "" : "s"}`}
                      </Typography>
                    </Box>
                  </Stack>
                  {space.id !== active.id && (
                    <Button
                      variant="outlined"
                      onClick={() => void switchSpace(space.id).then(() => saved(`Switched to ${space.name}`))}
                    >
                      Go to this Space
                    </Button>
                  )}
                </Stack>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center" mt={1.5}>
                  <ColorPicker space={space} />
                  <Box sx={{ flex: 1 }} />
                  <Button size="small" startIcon={<EditIcon fontSize="small" />} onClick={() => {
                    setNameError("");
                    setNaming({ space });
                  }}>
                    Rename
                  </Button>
                  <Button size="small" startIcon={<SaveFileIcon fontSize="small" />} onClick={() => void backup(space)}>
                    Save a backup
                  </Button>
                  <Button size="small" color="error" startIcon={<DeleteIcon fontSize="small" />} onClick={() => void remove(space)}>
                    {space.id === DEFAULT_SPACE_ID ? "Empty" : "Delete"}
                  </Button>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </SettingsCard>

        <SettingsCard title="What each Space keeps for itself">
          <Typography variant="body2">
            <strong>Kept apart in each Space:</strong> your chats, the facts it knows about you, your wishes (how you
            want it to work), and your task history. When you ask about “last time”, it only looks in the Space you are in.
          </Typography>
          <Typography variant="body2">
            <strong>Shared by all Spaces:</strong> your connected AI, your Skills, safety choices, scheduled tasks and
            settings. A scheduled task uses the notes of the Space it was made in.
          </Typography>
          <Note kind="tip" title="Example">
            Make a “Work” Space and tell it “I work at Infosys and I prefer short answers”. Your “Home” Space won't know
            any of that, and your work chats won't show up there.
          </Note>
        </SettingsCard>

        <SettingsCard
          title="Bring back a backup"
          intro="Pick a backup file you saved earlier. It comes back as a new Space, so nothing you have now is changed."
        >
          <Box>
            <Button variant="outlined" component="label" startIcon={<RestoreIcon fontSize="small" />}>
              Pick a backup file
              <input
                hidden
                type="file"
                accept=".json,application/json"
                data-testid="restore-input"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void file.text().then(async (text) => {
                    const parsed = parseSpaceBackup(text);
                    if (!parsed) {
                      setRestoreNote({ kind: "warning", text: "That file isn't a BrowserHarness Space backup. Pick the file that ends in “-backup.json”." });
                      return;
                    }
                    const result = await restoreSpace(parsed);
                    if (!result.ok) {
                      setRestoreNote({ kind: "warning", text: result.error });
                      return;
                    }
                    await refresh();
                    await countChats();
                    setRestoreNote({ kind: "success", text: `Brought back as “${result.space.name}”. Pick it from your Spaces to use it.` });
                    saved("Backup brought back");
                  });
                }}
              />
            </Button>
          </Box>
          {restoreNote && <Note kind={restoreNote.kind}>{restoreNote.text}</Note>}
        </SettingsCard>
      </Stack>

      <NameDialog
        open={Boolean(naming)}
        title={naming?.space ? `Rename ${naming.space.name}` : "Make a new Space"}
        intro={naming?.space ? undefined : "Give it a short name you'll recognise, like Work, Home or Family trip."}
        label="Name of the Space"
        placeholder="For example: Work"
        initial={naming?.space?.name ?? ""}
        confirmLabel={naming?.space ? "Save name" : "Make Space"}
        error={nameError}
        onClose={() => setNaming(null)}
        onSave={(value) => {
          const target = naming?.space;
          void (async () => {
            if (target) {
              const result = await renameSpace(target.id, value);
              if (!result.ok) return setNameError(result.error || "Not saved.");
              setNaming(null);
              saved("Space renamed");
            } else {
              const result = await createSpace(value);
              if (!result.ok) return setNameError(result.error);
              setNaming(null);
              await countChats();
              saved(`${result.space.name} is ready. You're in it now`);
            }
          })();
        }}
      />
    </>
  );
}
