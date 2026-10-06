import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { BackIcon, DeleteIcon, EditIcon } from "./icons";
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
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
      <Typography variant="subtitle2" mb={0.5}>
        How BrowserHarness should work for you
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={1}>
        A few lines it follows in every chat, task and scheduled run, unless a request says otherwise. They never switch
        off approvals.
      </Typography>
      <TextField
        fullWidth
        multiline
        minRows={3}
        maxRows={10}
        size="small"
        label="Your instructions"
        placeholder={"Answer briefly.\nShow prices in rupees.\nNever buy anything over ₹5,000 without asking me."}
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, MAX_INSTRUCTIONS))}
      />
      {note && (
        <Alert severity={note.severity} sx={{ mt: 1 }} onClose={() => setNote(null)}>
          {note.text}
        </Alert>
      )}
      <Stack direction="row" spacing={1} mt={1}>
        <Button variant="contained" size="small" disabled={text.trim() === saved} onClick={() => void save(text)}>
          Save instructions
        </Button>
        <Button
          size="small"
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
          Download
        </Button>
        <Button size="small" component="label">
          Load from file
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
    </Paper>
  );
}

export function MemoryView({ onBack }: { onBack: () => void }) {
  const [facts, setFacts] = useState<AboutMeFact[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [learn, setLearn] = useState(true);
  const [error, setError] = useState("");

  const refresh = async () => setFacts(await loadAboutMe());

  useEffect(() => {
    void refresh();
    void loadPreferences().then((preferences) => setLearn(preferences.learnAboutMe));
  }, []);

  const add = async () => {
    if (!draft.trim()) return;
    if (!isStorableFact(draft)) {
      setError("That looks like a password, card or ID number, so it isn't saved.");
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
      setError("That looks like a password, card or ID number, so it isn't saved.");
      return;
    }
    setError("");
    setEditing(null);
    await refresh();
  };

  return (
    <Box sx={{ minHeight: "100vh", p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={1}>
        <IconButton onClick={onBack} aria-label="Back to chat">
          <BackIcon />
        </IconButton>
        <Typography variant="h6" sx={{ flex: 1 }}>
          About me
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={2}>
        BrowserHarness keeps these facts in mind for every task, so you don't have to repeat yourself. They stay on
        this device. Type <code>/remember</code> in the chat to add one. When something changes, like where you live,
        the new fact replaces the old one.
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        It also remembers your past conversations: ask “what did I find last week about…?” or type{" "}
        <code>/recall</code> and a few words. Turn off task history in Settings to stop this.
      </Typography>

      <InstructionsCard />

      <Stack direction="row" spacing={1} mb={1}>
        <TextField
          size="small"
          fullWidth
          label="Add a fact about you"
          placeholder="I prefer aisle seats"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
        <Button variant="contained" onClick={() => void add()} disabled={!draft.trim()}>
          Add
        </Button>
      </Stack>
      {error && (
        <Alert severity="warning" sx={{ mb: 1 }} onClose={() => setError("")}>
          {error}
        </Alert>
      )}
      <FormControlLabel
        sx={{ mb: 2 }}
        control={
          <Switch
            checked={learn}
            onChange={async (event) => {
              setLearn(event.target.checked);
              await updatePreferences({ learnAboutMe: event.target.checked });
            }}
          />
        }
        label="Learn from my requests (like “my name is…” or “I prefer…”)"
      />

      {facts.length === 0 ? (
        <Alert severity="info">Nothing saved yet.</Alert>
      ) : (
        <Stack spacing={1}>
          {facts.map((fact) => (
            <Paper variant="outlined" sx={{ p: 1 }} key={fact.id} data-testid="about-me-fact">
              <Stack direction="row" spacing={1} alignItems="center">
                {editing?.id === fact.id ? (
                  <TextField
                    size="small"
                    fullWidth
                    autoFocus
                    value={editing.text}
                    onChange={(event) => setEditing({ id: fact.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveEdit();
                      if (event.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => void saveEdit()}
                  />
                ) : (
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {fact.text}
                  </Typography>
                )}
                {fact.source === "learned" && <Chip size="small" label="learned" variant="outlined" />}
                <Tooltip title="Edit">
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
            <Button
              color="error"
              size="small"
              onClick={async () => {
                await clearAboutMe();
                await refresh();
              }}
            >
              Forget everything
            </Button>
          </Box>
        </Stack>
      )}

      <Button sx={{ mt: 2 }} onClick={onBack}>
        Back to chat
      </Button>
    </Box>
  );
}
