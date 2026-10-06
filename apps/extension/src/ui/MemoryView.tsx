import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { DeleteIcon, EditIcon } from "./icons";
import { Note, ScreenFrame, SettingsCard, ToggleSetting, useConfirm } from "./kit";
import { useSaved } from "./feedback";
import { SpaceNote, useSpaces } from "./spaces-ui";
import {
  addFacts,
  clearAboutMe,
  clearGlobalAboutMe,
  isStorableFact,
  loadAboutMe,
  loadGlobalAboutMe,
  moveFact,
  removeFact,
  updateFact,
  type AboutMeFact,
  type FactScope
} from "../runtime/about-me";
import { loadPreferences, updatePreferences } from "../settings/preferences";
import {
  instructionsFile,
  instructionsFromFile,
  loadGlobalInstructions,
  loadInstructions,
  MAX_INSTRUCTIONS,
  saveGlobalInstructions,
  saveInstructions
} from "../runtime/instructions";

/**
 * How the person wants BrowserHarness to work: a few lines that go with every
 * request, either in this Space or in every Space.
 */
function InstructionsCard({ scope }: { scope: FactScope }) {
  const everySpace = scope === "global";
  const { active } = useSpaces();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [note, setNote] = useState<{ severity: "success" | "warning"; text: string } | null>(null);
  const notifySaved = useSaved();

  useEffect(() => {
    void (everySpace ? loadGlobalInstructions() : loadInstructions()).then((value) => {
      setText(value);
      setSaved(value);
    });
  }, [everySpace, active.id]);

  const save = async (value: string) => {
    const result = everySpace ? await saveGlobalInstructions(value) : await saveInstructions(value);
    if (!result.ok) {
      setNote({ severity: "warning", text: result.error || "Not saved." });
      return;
    }
    setSaved(value.trim());
    setText(value.trim());
    setNote({ severity: "success", text: "Saved. BrowserHarness follows these from your next request." });
    notifySaved("Your wishes are saved");
  };

  return (
    <SettingsCard
      title={everySpace ? "Your wishes for every Space" : "Your wishes for this Space"}
      intro={
        everySpace
          ? "Wishes that hold wherever you are, like “Answer briefly” or “Ask me before paying for anything”. They go with every chat and task in every Space."
          : "A few lines it follows in every chat, task and scheduled run in this Space, unless a request says otherwise. Where they disagree with your wishes for every Space, these win. They never switch off the approvals you chose under Safety."
      }
    >
      <TextField
        fullWidth
        multiline
        minRows={everySpace ? 2 : 3}
        maxRows={10}
        label={everySpace ? "Wishes for every Space" : "Your instructions"}
        placeholder={
          everySpace
            ? "Answer briefly.\nAsk me before paying for anything."
            : "Show prices in rupees.\nNever buy anything over ₹5,000 without asking me."
        }
        helperText={`Write one wish per line, the way you would tell a person. Up to ${MAX_INSTRUCTIONS} letters (${text.length} used).`}
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, MAX_INSTRUCTIONS))}
      />
      {note && <Note kind={note.severity === "success" ? "success" : "warning"}>{note.text}</Note>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" disabled={text.trim() === saved} onClick={() => void save(text)}>
          {everySpace ? "Save for every Space" : "Save instructions"}
        </Button>
        <Button
          disabled={!saved}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([instructionsFile(saved)], { type: "text/markdown" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = everySpace ? "INSTRUCTIONS-ALL-SPACES.md" : "INSTRUCTIONS.md";
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
            aria-label={everySpace ? "Load wishes for every Space from a file" : "Load instructions from a file"}
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

/** One saved fact, with change, move and delete. */
function FactRow({
  fact,
  scope,
  editing,
  setEditing,
  onSaveEdit,
  onMove,
  onDelete
}: {
  fact: AboutMeFact;
  scope: FactScope;
  editing: { id: string; text: string } | null;
  setEditing: (value: { id: string; text: string } | null) => void;
  onSaveEdit: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 1, pl: 1.5 }} data-testid="about-me-fact" data-scope={scope}>
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
              if (event.key === "Enter") onSaveEdit();
              if (event.key === "Escape") setEditing(null);
            }}
            onBlur={onSaveEdit}
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
        <Tooltip title={scope === "global" ? "Keep this only in the Space you're in" : "Use this in every Space"}>
          <Button size="small" onClick={onMove} aria-label={scope === "global" ? `Only this Space: ${fact.text}` : `Every Space: ${fact.text}`}>
            {scope === "global" ? "Only this Space" : "Every Space"}
          </Button>
        </Tooltip>
        <Tooltip title="Change">
          <IconButton size="small" aria-label={`Edit ${fact.text}`} onClick={() => setEditing({ id: fact.id, text: fact.text })}>
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete">
          <IconButton size="small" aria-label={`Delete ${fact.text}`} onClick={onDelete}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Paper>
  );
}

export function MemoryView({ onBack, embedded }: { onBack: () => void; embedded?: boolean }) {
  const [facts, setFacts] = useState<AboutMeFact[]>([]);
  const [everywhere, setEverywhere] = useState<AboutMeFact[]>([]);
  const [draft, setDraft] = useState("");
  const [draftEverywhere, setDraftEverywhere] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string; scope?: FactScope } | null>(null);
  const [learn, setLearn] = useState(true);
  const [error, setError] = useState("");
  const [dialog, confirm] = useConfirm();
  const saved = useSaved();
  const { active } = useSpaces();

  const refresh = async () => {
    setFacts(await loadAboutMe());
    setEverywhere(await loadGlobalAboutMe());
  };

  useEffect(() => {
    void refresh();
    void loadPreferences().then((preferences) => setLearn(preferences.learnAboutMe));
  }, [active.id]);

  const add = async () => {
    if (!draft.trim()) return;
    if (!isStorableFact(draft)) {
      setError(NOT_SAVED);
      return;
    }
    setError("");
    await addFacts([draft], "you", undefined, draftEverywhere ? "global" : "space");
    setDraft("");
    await refresh();
    saved(draftEverywhere ? "Fact saved for every Space" : "Fact saved");
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!(await updateFact(editing.id, editing.text, editing.scope ?? "space"))) {
      setError(NOT_SAVED);
      return;
    }
    setError("");
    setEditing(null);
    await refresh();
  };

  const forgetAll = async (scope: FactScope) => {
    const count = scope === "global" ? everywhere.length : facts.length;
    const ok = await confirm({
      title: scope === "global" ? "Forget every fact you use in every Space?" : "Forget every fact about you in this Space?",
      body: `All ${count} saved fact${count === 1 ? "" : "s"} will be deleted. Your wishes stay. This can't be undone.`,
      confirmLabel: "Forget everything",
      danger: true
    });
    if (!ok) return;
    if (scope === "global") await clearGlobalAboutMe();
    else await clearAboutMe();
    await refresh();
  };

  const list = (items: AboutMeFact[], scope: FactScope) =>
    items.map((fact) => (
      <FactRow
        key={fact.id}
        fact={fact}
        scope={scope}
        editing={editing}
        setEditing={(value) => setEditing(value ? { ...value, scope } : null)}
        onSaveEdit={() => void saveEdit()}
        onMove={async () => {
          await moveFact(fact.id, scope === "global" ? "space" : "global");
          await refresh();
          saved(scope === "global" ? `Moved to ${active.name} only` : "Now used in every Space");
        }}
        onDelete={async () => {
          await removeFact(fact.id, scope);
          await refresh();
        }}
      />
    ));

  return (
    <ScreenFrame
      title={embedded ? "About you" : "About me"}
      embedded={embedded}
      onBack={onBack}
      intro="BrowserHarness keeps these in mind for every task, so you don't have to repeat yourself. They stay on this computer."
    >
      {dialog}
      <SpaceNote what="Facts and wishes marked for this Space are kept" />
      <Stack spacing={2.5}>
        <SettingsCard
          title="Facts about you"
          intro={
            <>
              Things like your city, your sizes or your favourite airline. You can also type <code>/remember</code> and
              a fact in the chat. When something changes, the new fact replaces the old one. Your name, your city and
              your language are used in every Space; everything else stays in the Space where you said it, unless you
              press <strong>Every Space</strong>.
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
          <FormControlLabel
            control={<Checkbox checked={draftEverywhere} onChange={(event) => setDraftEverywhere(event.target.checked)} />}
            label="Use this fact in every Space, not just this one"
          />
          {error && <Note kind="warning">{error}</Note>}
          <Typography variant="subtitle2" component="h3">
            In this Space
          </Typography>
          {facts.length === 0 ? (
            <Note kind="info">Nothing saved for this Space yet.</Note>
          ) : (
            <Stack spacing={1} data-testid="space-facts">
              {list(facts, "space")}
              <Box>
                <Button color="error" variant="outlined" size="small" onClick={() => void forgetAll("space")}>
                  Forget everything
                </Button>
              </Box>
            </Stack>
          )}
          <Typography variant="subtitle2" component="h3">
            In every Space
          </Typography>
          {everywhere.length === 0 ? (
            <Note kind="info">Nothing is shared with all your Spaces yet.</Note>
          ) : (
            <Stack spacing={1} data-testid="every-space-facts">
              {list(everywhere, "global")}
              <Box>
                <Button color="error" variant="outlined" size="small" onClick={() => void forgetAll("global")}>
                  Forget what every Space knows
                </Button>
              </Box>
            </Stack>
          )}
        </SettingsCard>

        <InstructionsCard scope="space" />
        <InstructionsCard scope="global" />

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
              saved(value ? "Saved. Turned on" : "Saved. Turned off");
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
