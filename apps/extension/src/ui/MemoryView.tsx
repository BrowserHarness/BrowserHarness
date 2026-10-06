import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { DeleteIcon, EditIcon } from "./icons";
import { Note, ScreenFrame, SettingsCard, ToggleSetting, useConfirm } from "./kit";
import {
  addFacts,
  clearAboutMe,
  isStorableFact,
  loadAboutMe,
  removeFact,
  updateFact,
  type AboutMeFact
} from "../runtime/about-me";
import { loadPreferences, updatePreferences } from "../settings/preferences";
import {
  instructionsFile,
  instructionsFromFile,
  loadInstructions,
  MAX_INSTRUCTIONS,
  saveInstructions
} from "../runtime/instructions";

/** How the person wants BrowserHarness to work: a few lines that go with every request. */
function InstructionsCard() {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [note, setNote] = useState<{ severity: "success" | "warning"; text: string } | null>(null);

  useEffect(() => {
    void loadInstructions().then((value) => {
      setText(value);
      setSaved(value);
    });
  }, []);

  const save = async (value: string) => {
    const result = await saveInstructions(value);
    if (!result.ok) {
      setNote({ severity: "warning", text: result.error || "Not saved." });
      return;
    }
    setSaved(value.trim());
    setText(value.trim());
    setNote({ severity: "success", text: "Saved. BrowserHarness follows these from your next request." });
  };

  return (
    <SettingsCard
      title="Your wishes"
      intro="A few lines it follows in every chat, task and scheduled run, unless a request says otherwise. They never switch off the approvals you chose under Safety."
    >
      <TextField
        fullWidth
        multiline
        minRows={3}
        maxRows={10}
        label="Your instructions"
        placeholder={"Answer briefly.\nShow prices in rupees.\nNever buy anything over ₹5,000 without asking me."}
        helperText={`Write one wish per line, the way you would tell a person. Up to ${MAX_INSTRUCTIONS} letters (${text.length} used).`}
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, MAX_INSTRUCTIONS))}
      />
      {note && <Note kind={note.severity === "success" ? "success" : "warning"}>{note.text}</Note>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" disabled={text.trim() === saved} onClick={() => void save(text)}>
          Save instructions
        </Button>
        <Button
          disabled={!saved}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([instructionsFile(saved)], { type: "text/markdown" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "INSTRUCTIONS.md";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Save a copy to a file
        </Button>
        <Button component="label">
          Load from a file
          <input
            hidden
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            aria-label="Load instructions from a file"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) await save(instructionsFromFile(await file.text()));
            }}
          />
        </Button>
      </Stack>
    </SettingsCard>
  );
}

const NOT_SAVED = "That looks like a password, card or ID number, so it isn't saved. BrowserHarness never keeps those.";

export function MemoryView({ onBack, embedded }: { onBack: () => void; embedded?: boolean }) {
  const [facts, setFacts] = useState<AboutMeFact[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [learn, setLearn] = useState(true);
  const [error, setError] = useState("");
  const [dialog, confirm] = useConfirm();

  const refresh = async () => setFacts(await loadAboutMe());

  useEffect(() => {
    void refresh();
    void loadPreferences().then((preferences) => setLearn(preferences.learnAboutMe));
  }, []);

  const add = async () => {
    if (!draft.trim()) return;
    if (!isStorableFact(draft)) {
      setError(NOT_SAVED);
      return;
    }
    setError("");
    await addFacts([draft], "you");
    setDraft("");
    await refresh();
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!(await updateFact(editing.id, editing.text))) {
      setError(NOT_SAVED);
      return;
    }
    setError("");
    setEditing(null);
    await refresh();
  };

  const forgetAll = async () => {
    const ok = await confirm({
      title: "Forget every fact about you?",
      body: `All ${facts.length} saved fact${facts.length === 1 ? "" : "s"} will be deleted. Your wishes stay. This can't be undone.`,
      confirmLabel: "Forget everything",
      danger: true
    });
    if (!ok) return;
    await clearAboutMe();
    await refresh();
  };

  return (
    <ScreenFrame
      title={embedded ? "About you" : "About me"}
      embedded={embedded}
      onBack={onBack}
      intro="BrowserHarness keeps these in mind for every task, so you don't have to repeat yourself. They stay on this computer."
    >
      {dialog}
      <Stack spacing={2.5}>
        <SettingsCard
          title="Facts about you"
          intro={
            <>
              Things like your city, your sizes or your favourite airline. You can also type <code>/remember</code> and
              a fact in the chat. When something changes, the new fact replaces the old one.
            </>
          }
        >
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              fullWidth
              label="Add a fact about you"
              placeholder="I prefer aisle seats"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
              }}
            />
            <Button variant="contained" onClick={() => void add()} disabled={!draft.trim()} sx={{ mt: 1 }}>
              Add
            </Button>
          </Stack>
          {error && <Note kind="warning">{error}</Note>}
          {facts.length === 0 ? (
            <Note kind="info">Nothing saved yet.</Note>
          ) : (
            <Stack spacing={1}>
              {facts.map((fact) => (
                <Paper variant="outlined" sx={{ p: 1, pl: 1.5 }} key={fact.id} data-testid="about-me-fact">
                  <Stack direction="row" spacing={1} alignItems="center">
                    {editing?.id === fact.id ? (
                      <TextField
                        size="small"
                        fullWidth
                        autoFocus
                        label="Change this fact"
                        value={editing.text}
                        onChange={(event) => setEditing({ id: fact.id, text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveEdit();
                          if (event.key === "Escape") setEditing(null);
                        }}
                        onBlur={() => void saveEdit()}
                      />
                    ) : (
                      <Typography variant="body1" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                        {fact.text}
                      </Typography>
                    )}
                    {fact.source === "learned" && (
                      <Tooltip title="It noticed this in one of your requests">
                        <Chip size="small" label="learned" variant="outlined" />
                      </Tooltip>
                    )}
                    <Tooltip title="Change">
                      <IconButton size="small" aria-label={`Edit ${fact.text}`} onClick={() => setEditing({ id: fact.id, text: fact.text })}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        aria-label={`Delete ${fact.text}`}
                        onClick={async () => {
                          await removeFact(fact.id);
                          await refresh();
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Paper>
              ))}
              <Box>
                <Button color="error" variant="outlined" size="small" onClick={() => void forgetAll()}>
                  Forget everything
                </Button>
              </Box>
            </Stack>
          )}
        </SettingsCard>

        <InstructionsCard />

        <SettingsCard>
          <ToggleSetting
            label="Remember facts you mention"
            help="When you say things like “my name is…” or “I prefer…” in a request, it saves them here."
            whenOn="It notices facts in your requests and adds them to the list above, marked “learned”."
            whenOff="Only the facts you add yourself are kept."
            recommended="Keep this on. It never saves passwords, card numbers or ID numbers."
            checked={learn}
            onChange={async (value) => {
              setLearn(value);
              await updatePreferences({ learnAboutMe: value });
            }}
          />
        </SettingsCard>

        <Note kind="tip" title="It also remembers your past tasks">
          Ask “what did I find last week about kettles?” or type <code>/recall</code> and a few words. To stop this,
          turn off task history under Settings, Learning &amp; memory.
        </Note>
      </Stack>
    </ScreenFrame>
  );
}
