import { useEffect, useRef, useState } from "react";
import {
  Alert,
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
import { BackIcon, DeleteIcon, DownloadIcon, EditIcon, ReplayIcon, RunIcon, UploadIcon } from "./icons";
import {
  deleteSkill,
  loadSkills,
  parseSkillMd,
  renameSkill,
  saveSkill,
  skillFromRecording,
  toSkillMd,
  type UserSkill
} from "../runtime/skills";
import { BUILT_IN_COMMANDS } from "../runtime/slash-commands";
import { deleteWorkflow, loadWorkflows, type SavedWorkflow } from "../runtime/workflows";
import {
  deleteSiteSkillCandidate,
  listSiteSkillCandidateSummaries,
  type SiteSkillCandidateSummary
} from "../runtime/site-skill-store";

const RESERVED = BUILT_IN_COMMANDS.map((command) => command.name);

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function runSummary(skill: UserSkill): string {
  if (!skill.runs) return "Not run yet";
  const times = skill.runs === 1 ? "once" : `${skill.runs} times`;
  return `Ran ${times}, worked ${skill.successes}`;
}

export function SkillsView({
  onBack,
  onRun,
  onReplay
}: {
  onBack: () => void;
  onRun: (skill: UserSkill) => void;
  onReplay: (workflow: SavedWorkflow) => void;
}) {
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [recordings, setRecordings] = useState<SavedWorkflow[]>([]);
  const [siteSkills, setSiteSkills] = useState<SiteSkillCandidateSummary[]>([]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ severity: "success" | "error"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = async () => {
    setSkills(await loadSkills());
    setRecordings(await loadWorkflows());
    setSiteSkills(await listSiteSkillCandidateSummaries().catch(() => []));
  };

  useEffect(() => {
    void refresh();
  }, []);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const added: string[] = [];
    for (const file of Array.from(files)) {
      const parsed = parseSkillMd(await file.text());
      if (!parsed.ok) {
        setNotice({ severity: "error", text: `${file.name}: ${parsed.error}` });
        continue;
      }
      const saved = await saveSkill(parsed.skill, RESERVED);
      added.push(`/${saved.slug}`);
    }
    if (added.length) setNotice({ severity: "success", text: `Imported ${added.join(", ")}. Nothing runs until you start it.` });
    if (fileInput.current) fileInput.current.value = "";
    await refresh();
  };

  const finishRename = async () => {
    if (!editing) return;
    await renameSkill(editing.id, editing.name, RESERVED);
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
          Skills
        </Typography>
        <Button size="small" startIcon={<UploadIcon fontSize="small" />} onClick={() => fileInput.current?.click()}>
          Import SKILL.md
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".md,text/markdown,text/plain"
          multiple
          hidden
          data-testid="skill-import-input"
          onChange={(event) => void importFiles(event.target.files)}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={2}>
        A Skill is a task BrowserHarness has learned. Run one here or type <code>/</code> and its name in the chat.
        Each run that goes wrong teaches it a lesson for next time.
      </Typography>

      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 2 }}>
          {notice.text}
        </Alert>
      )}

      <Typography variant="subtitle2" mb={1}>
        Your Skills
      </Typography>
      {skills.length === 0 ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          No Skills yet. After a task finishes, press <strong>Save as Skill</strong> under the answer, or import a SKILL.md file.
        </Alert>
      ) : (
        <Stack spacing={1.5} mb={2}>
          {skills.map((skill) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} key={skill.id} data-testid="skill-card">
              <Stack spacing={0.75}>
                {editing?.id === skill.id ? (
                  <TextField
                    size="small"
                    autoFocus
                    label="Skill name"
                    value={editing.name}
                    onChange={(event) => setEditing({ id: skill.id, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void finishRename();
                      if (event.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => void finishRename()}
                  />
                ) : (
                  <Typography variant="subtitle2">{skill.name}</Typography>
                )}
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={`/${skill.slug}`} variant="outlined" />
                  <Typography variant="caption" color="text.secondary">
                    {runSummary(skill)}
                    {skill.lessons.length ? ` · ${skill.lessons.length} lesson${skill.lessons.length === 1 ? "" : "s"} learned` : ""}
                  </Typography>
                </Stack>
                {skill.description && skill.description !== skill.name && (
                  <Typography variant="body2" color="text.secondary">
                    {skill.description}
                  </Typography>
                )}
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Button size="small" variant="contained" startIcon={<RunIcon fontSize="small" />} onClick={() => onRun(skill)}>
                    Run
                  </Button>
                  <Tooltip title="Rename">
                    <IconButton size="small" aria-label={`Rename ${skill.name}`} onClick={() => setEditing({ id: skill.id, name: skill.name })}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Export as SKILL.md">
                    <IconButton
                      size="small"
                      aria-label={`Export ${skill.name}`}
                      onClick={() => downloadText(toSkillMd(skill), `${skill.slug}-SKILL.md`)}
                    >
                      <DownloadIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      aria-label={`Delete ${skill.name}`}
                      onClick={async () => {
                        await deleteSkill(skill.id);
                        await refresh();
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      {recordings.length > 0 && (
        <>
          <Typography variant="subtitle2" mb={1}>
            Recordings (Watch Me & Learn)
          </Typography>
          <Stack spacing={1.5} mb={2}>
            {recordings.map((workflow) => (
              <Paper variant="outlined" sx={{ p: 1.5 }} key={workflow.id}>
                <Typography variant="subtitle2">{workflow.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"} · {new Date(workflow.created_at).toLocaleString()}
                </Typography>
                <Stack direction="row" spacing={0.5} mt={0.5}>
                  <Button size="small" startIcon={<ReplayIcon fontSize="small" />} onClick={() => onReplay(workflow)}>
                    Replay
                  </Button>
                  <Button
                    size="small"
                    onClick={async () => {
                      const saved = await saveSkill(skillFromRecording(workflow), RESERVED);
                      setNotice({ severity: "success", text: `Saved as /${saved.slug}.` });
                      await refresh();
                    }}
                  >
                    Make a Skill
                  </Button>
                  <IconButton
                    size="small"
                    aria-label={`Delete recording ${workflow.name}`}
                    onClick={async () => {
                      await deleteWorkflow(workflow.id);
                      await refresh();
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </>
      )}

      {siteSkills.length > 0 && (
        <>
          <Typography variant="subtitle2" mb={1}>
            Site Skills (built from a website's own requests)
          </Typography>
          <Stack spacing={1.5} mb={2}>
            {siteSkills.map((site) => (
              <Paper variant="outlined" sx={{ p: 1.5 }} key={site.id}>
                <Typography variant="subtitle2">{site.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {site.origin} · {site.recipe_count} action{site.recipe_count === 1 ? "" : "s"} ·{" "}
                  {site.lifecycle_status === "active" ? "in use" : "being tested"}
                  {site.verification_status === "failed" ? " · last check failed" : ""}
                </Typography>
                <Box>
                  <IconButton
                    size="small"
                    aria-label={`Delete site Skill ${site.name}`}
                    onClick={async () => {
                      await deleteSiteSkillCandidate(site.id);
                      await refresh();
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Paper>
            ))}
          </Stack>
        </>
      )}

      <Button onClick={onBack}>Back to chat</Button>
    </Box>
  );
}
