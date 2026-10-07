import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { DeleteIcon, DownloadIcon, EditIcon, MoreIcon, ReplayIcon, RunIcon, UploadIcon } from "./icons";
import { ScreenFrame, SettingsCard, ToggleSetting, useConfirm } from "./kit";
import { useSpaces } from "./spaces-ui";
import { useSaved } from "./feedback";
import {
  copySkillToSpace,
  deleteSkill,
  loadSkills,
  ownedBySpace,
  setSkillReach,
  fetchSkillMd,
  parseSkillMd,
  renameSkill,
  saveSkill,
  skillFromRecording,
  toSkillMd,
  type UserSkill
} from "../runtime/skills";
import { BUILT_IN_COMMANDS } from "../runtime/slash-commands";
import { loadPreferences, updatePreferences } from "../settings/preferences";
import { loadSiteCommands, renameSiteCommand, usage, type SiteCommand } from "../runtime/site-commands";
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
  onReplay,
  onUseCommand,
  embedded
}: {
  onBack: () => void;
  /** Inside Settings: no back button of its own. */
  embedded?: boolean;
  onRun: (skill: UserSkill) => void;
  onReplay: (workflow: SavedWorkflow) => void;
  /** Puts "/name " in the chat box so the person can add the details. */
  onUseCommand: (name: string) => void;
}) {
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [recordings, setRecordings] = useState<SavedWorkflow[]>([]);
  const [siteSkills, setSiteSkills] = useState<SiteSkillCandidateSummary[]>([]);
  const [siteCommands, setSiteCommands] = useState<SiteCommand[]>([]);
  const [editingCommand, setEditingCommand] = useState<{ key: string; name: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ severity: "success" | "error"; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [autoSkills, setAutoSkills] = useState(true);
  const saved = useSaved();
  const { spaces, active } = useSpaces();
  const [dialog, confirm] = useConfirm();
  const [more, setMore] = useState<{ anchor: HTMLElement; skill: UserSkill } | null>(null);

  const refresh = async () => {
    setSkills(await loadSkills(active.id));
    setRecordings(await loadWorkflows());
    setSiteSkills(await listSiteSkillCandidateSummaries().catch(() => []));
    setSiteCommands(await loadSiteCommands().catch(() => []));
  };

  const finishCommandRename = async () => {
    if (!editingCommand) return;
    await renameSiteCommand(editingCommand.key, editingCommand.name);
    setEditingCommand(null);
    await refresh();
  };

  useEffect(() => {
    void loadPreferences().then((preferences) => setAutoSkills(preferences.autoSkills));
  }, []);
  // Each Space has its own Skills: the list follows the Space in use.
  useEffect(() => {
    void refresh();
  }, [active.id]);

  const otherSpaces = spaces.filter((space) => space.id !== active.id);
  const reachText = (skill: UserSkill) => (skill.visibility === "all" ? "Every Space" : "This Space");

  const changeReach = async (skill: UserSkill, reach: "every-space" | "this-space") => {
    setMore(null);
    const changed = await setSkillReach(skill.id, reach, active.id);
    setNotice(
      changed
        ? { severity: "success", text: reach === "every-space" ? `/${skill.slug} can now be used in every Space.` : `/${skill.slug} is now only in ${active.name}.` }
        : { severity: "error", text: "That Skill isn't in this Space any more." }
    );
    await refresh();
  };

  const copyTo = async (skill: UserSkill, spaceId: string) => {
    setMore(null);
    const copy = await copySkillToSpace(skill.id, spaceId, active.id, RESERVED);
    const name = spaces.find((space) => space.id === spaceId)?.name ?? "that Space";
    setNotice(
      copy
        ? { severity: "success", text: `Copied to ${name} as /${copy.slug}. The copy is separate: changing one won't change the other.` }
        : { severity: "error", text: "Couldn't copy that Skill." }
    );
    await refresh();
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const added: string[] = [];
    for (const file of Array.from(files)) {
      const parsed = parseSkillMd(await file.text());
      if (!parsed.ok) {
        setNotice({ severity: "error", text: `${file.name}: ${parsed.error}` });
        continue;
      }
      const saved = await saveSkill(parsed.skill, RESERVED, active.id);
      added.push(`/${saved.slug}`);
    }
    if (added.length) setNotice({ severity: "success", text: `Imported ${added.join(", ")}. Nothing runs until you start it.` });
    if (fileInput.current) fileInput.current.value = "";
    await refresh();
  };

  const importLink = async () => {
    if (!link?.trim()) return;
    const parsed = await fetchSkillMd(link);
    if (!parsed.ok) {
      setNotice({ severity: "error", text: parsed.error });
      return;
    }
    const saved = await saveSkill(parsed.skill, RESERVED, active.id);
    setNotice({ severity: "success", text: `Imported /${saved.slug} from ${new URL(link.trim()).hostname}. Read its steps before you run it; nothing runs until you start it.` });
    setLink(null);
    await refresh();
  };

  const finishRename = async () => {
    if (!editing) return;
    await renameSkill(editing.id, editing.name, RESERVED, active.id);
    setEditing(null);
    await refresh();
  };

  const importButtons = (
    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
      <Button size="small" startIcon={<UploadIcon fontSize="small" />} onClick={() => fileInput.current?.click()}>
        From a file
      </Button>
      <Button size="small" onClick={() => setLink(link === null ? "" : null)}>
        From a link
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
  );

  return (
    <ScreenFrame
      title={embedded ? "Saved Skills" : "Skills"}
      embedded={embedded}
      onBack={onBack}
      action={importButtons}
      intro={
        <>
          A Skill is a task BrowserHarness has learned and can repeat. Run one here, or type <code>/</code> and its name
          in the chat. When you ask for something similar, it follows the Skill by itself. A shorter way updates the
          Skill, and a run that goes wrong teaches it a lesson. A Skill stays in the Space it was made in; use the
          ⋯ button to use it in every Space or copy it to another Space.
        </>
      }
    >
      {link !== null && (
        <Stack direction="row" spacing={1} mb={1.5}>
          <TextField
            size="small"
            fullWidth
            autoFocus
            label="Link to a SKILL.md"
            placeholder="https://github.com/someone/skills/blob/main/tea/SKILL.md"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void importLink();
            }}
          />
          <Button variant="contained" size="small" disabled={!link.trim()} onClick={() => void importLink()}>
            Import
          </Button>
        </Stack>
      )}
      <Box mb={2.5}>
        <SettingsCard>
          <ToggleSetting
            label="Learn Skills on its own"
            help="When a task takes several steps and works, BrowserHarness keeps it as a Skill and does it faster next time."
            whenOn="Finished tasks with several steps are saved as Skills marked “Learned on its own”, and it follows a matching Skill next time."
            whenOff="It only keeps the Skills you save yourself with the “Save as Skill” button."
            recommended="Keep this on. You can delete any Skill it learns, or press “Keep” to make it permanent."
            checked={autoSkills}
            onChange={async (value) => {
              setAutoSkills(value);
              await updatePreferences({ autoSkills: value });
              saved(value ? "Saved. Turned on" : "Saved. Turned off");
            }}
          />
        </SettingsCard>
      </Box>

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
                  <Chip size="small" label={reachText(skill)} data-testid="skill-reach" />
                  {skill.source === "auto" && <Chip size="small" color="info" label="Learned on its own" />}
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
                  {skill.source === "auto" && (
                    <Button
                      size="small"
                      onClick={async () => {
                        await saveSkill({ ...skill, source: "chat" }, RESERVED, active.id);
                        await refresh();
                      }}
                    >
                      Keep
                    </Button>
                  )}
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
                        if (
                          skill.visibility === "all" &&
                          !(await confirm({
                            title: `Delete /${skill.slug}?`,
                            body: "This Skill is used in every Space, so it will be gone from all of them. Copies you made in other Spaces stay.",
                            confirmLabel: "Delete it everywhere",
                            danger: true
                          }))
                        )
                          return;
                        await deleteSkill(skill.id, active.id);
                        await refresh();
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Where it can be used">
                    <IconButton size="small" aria-label={`More for ${skill.name}`} onClick={(event) => setMore({ anchor: event.currentTarget, skill })}>
                      <MoreIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Menu anchorEl={more?.anchor} open={Boolean(more)} onClose={() => setMore(null)}>
        {more && ownedBySpace(more.skill, active.id) && (
          <MenuItem onClick={() => void changeReach(more.skill, "every-space")}>Use it in every Space</MenuItem>
        )}
        {more && more.skill.visibility === "all" && (
          <MenuItem onClick={() => void changeReach(more.skill, "this-space")}>Use it only in this Space</MenuItem>
        )}
        {more &&
          otherSpaces.map((space) => (
            <MenuItem key={space.id} onClick={() => void copyTo(more.skill, space.id)}>
              Copy to {space.name}
            </MenuItem>
          ))}
        {more && otherSpaces.length === 0 && more.skill.visibility !== "all" && (
          <MenuItem disabled>Make another Space to copy this Skill into it</MenuItem>
        )}
      </Menu>
      {dialog}

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
                      const saved = await saveSkill(skillFromRecording(workflow), RESERVED, active.id);
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
          <Typography variant="body2" color="text.secondary" mb={1}>
            Each one gives you commands. Type one in the chat, like <code>/name what to search</code>, and it runs
            straight away. Coding tools and the helper app can run them too.
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
                <Stack spacing={0.5} mt={0.75}>
                  {siteCommands
                    .filter((command) => command.skill_id === site.id)
                    .map((command) => (
                      <Stack direction="row" spacing={0.5} alignItems="center" key={command.key} data-testid="site-command">
                        {editingCommand?.key === command.key ? (
                          <TextField
                            size="small"
                            autoFocus
                            label="Command name"
                            value={editingCommand.name}
                            onChange={(event) => setEditingCommand({ key: command.key, name: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void finishCommandRename();
                              if (event.key === "Escape") setEditingCommand(null);
                            }}
                            onBlur={() => void finishCommandRename()}
                          />
                        ) : (
                          <Tooltip title={`${command.kind === "read" ? "Gets data" : "Fills a form"}. ${usage(command)}`} describeChild>
                            <Chip
                              size="small"
                              label={`/${command.name}`}
                              variant="outlined"
                              onClick={() => onUseCommand(command.name)}
                            />
                          </Tooltip>
                        )}
                        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                          {command.kind === "read" ? "gets data" : "fills a form"}
                          {command.runs ? ` · worked ${command.worked} of ${command.runs}` : ""}
                        </Typography>
                        <Tooltip title="Rename command">
                          <IconButton
                            size="small"
                            aria-label={`Rename command ${command.name}`}
                            onClick={() => setEditingCommand({ key: command.key, name: command.name })}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    ))}
                </Stack>
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

    </ScreenFrame>
  );
}
