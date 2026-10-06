// One place for everything BrowserHarness can be set to do. In the big
// Settings tab the pages are listed on the left; in the narrow side panel the
// list comes first and each page opens on its own.
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Box,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import {
  BackIcon,
  HelpIcon,
  HistoryIcon,
  HomeIcon,
  LockIcon,
  MemoryIcon,
  NextIcon,
  OpenIcon,
  PaletteIcon,
  PersonIcon,
  PhoneIcon,
  PlugIcon,
  SafetyIcon,
  ScheduleIcon,
  SkillsIcon,
  SparklesIcon,
  type IconProps
} from "../icons";
import type { SavedWorkflow } from "../../runtime/workflows";
import { HomePage } from "./HomePage";
import { AiPage } from "./AiPage";
import { SafetyPage } from "./SafetyPage";
import { LearningPage } from "./LearningPage";
import { PhonePage } from "./PhonePage";
import { HelperAppPage } from "./HelperAppPage";
import { LookPage } from "./LookPage";
import { PrivacyPage } from "./PrivacyPage";
import { HelpPage } from "./HelpPage";
import { MemoryView } from "../MemoryView";
import { SkillsView } from "../SkillsView";
import { ScheduledView } from "../ScheduledView";
import { HistoryView } from "../HistoryView";
import { handToSidePanel } from "./handoff";

export type SectionId =
  | "home"
  | "ai"
  | "safety"
  | "about"
  | "skills"
  | "scheduled"
  | "history"
  | "learning"
  | "phone"
  | "helper"
  | "look"
  | "privacy"
  | "help";

interface SectionInfo {
  id: SectionId;
  label: string;
  /** One line under the name in the list. */
  hint: string;
  icon: ComponentType<IconProps>;
  group: string;
}

export const SECTIONS: SectionInfo[] = [
  { id: "home", label: "Start here", hint: "What's set up, and what to do next", icon: HomeIcon, group: "Getting started" },
  { id: "ai", label: "Your AI", hint: "The AI that reads pages and does your tasks", icon: SparklesIcon, group: "Getting started" },
  { id: "safety", label: "Safety & approvals", hint: "When it must ask you before acting", icon: SafetyIcon, group: "Getting started" },
  { id: "about", label: "About you", hint: "Facts and wishes it keeps in mind", icon: PersonIcon, group: "Your things" },
  { id: "skills", label: "Saved Skills", hint: "Tasks it learned and can repeat", icon: SkillsIcon, group: "Your things" },
  { id: "scheduled", label: "Scheduled tasks", hint: "Tasks that run by themselves", icon: ScheduleIcon, group: "Your things" },
  { id: "history", label: "Task history", hint: "Everything it did for you", icon: HistoryIcon, group: "Your things" },
  { id: "phone", label: "Phone & chat apps", hint: "Send tasks from Telegram, Discord, Slack or email", icon: PhoneIcon, group: "Connect more" },
  { id: "helper", label: "Helper app", hint: "The small program for your phone and coding tools", icon: PlugIcon, group: "Connect more" },
  { id: "learning", label: "Learning & memory", hint: "What it remembers and learns on its own", icon: MemoryIcon, group: "Preferences" },
  { id: "look", label: "Look & text size", hint: "Light or dark, bigger words", icon: PaletteIcon, group: "Preferences" },
  { id: "privacy", label: "Privacy & your data", hint: "What is kept, and how to delete it", icon: LockIcon, group: "Preferences" },
  { id: "help", label: "Help", hint: "Simple answers to common questions", icon: HelpIcon, group: "Preferences" }
];

export function isSectionId(value: unknown): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}

export interface SettingsActions {
  /** Run a request in the chat (a Skill, a past task). */
  runTask: (text: string) => void;
  /** Put text in the chat box for the person to finish. */
  fillPrompt: (text: string) => void;
  /** Replay a "Watch me" recording. */
  replay?: (workflow: SavedWorkflow) => void;
}

/** In the big tab, requests go to the side panel's chat. */
export const PAGE_ACTIONS: SettingsActions = {
  runTask: (text) => handToSidePanel(text, true),
  fillPrompt: (text) => handToSidePanel(text, false)
};

export interface SectionProps {
  go: (section: SectionId) => void;
  actions: SettingsActions;
  /** True in the narrow side panel. */
  compact: boolean;
}

function SectionPage({ id, props }: { id: SectionId; props: SectionProps }) {
  const { go, actions } = props;
  switch (id) {
    case "home":
      return <HomePage {...props} />;
    case "ai":
      return <AiPage {...props} />;
    case "safety":
      return <SafetyPage {...props} />;
    case "about":
      return <MemoryView embedded onBack={() => go("home")} />;
    case "skills":
      return (
        <SkillsView
          embedded
          onBack={() => go("home")}
          onRun={(skill) => actions.runTask(`/${skill.slug}`)}
          onReplay={(workflow) => (actions.replay ? actions.replay(workflow) : actions.fillPrompt(`Replay my recording "${workflow.name}"`))}
          onUseCommand={(name) => actions.fillPrompt(`/${name} `)}
        />
      );
    case "scheduled":
      return <ScheduledView embedded />;
    case "history":
      return <HistoryView embedded onBack={() => go("home")} onRunAgain={(task) => actions.fillPrompt(task)} />;
    case "learning":
      return <LearningPage {...props} />;
    case "phone":
      return <PhonePage {...props} />;
    case "helper":
      return <HelperAppPage {...props} />;
    case "look":
      return <LookPage {...props} />;
    case "privacy":
      return <PrivacyPage {...props} />;
    case "help":
      return <HelpPage {...props} />;
  }
}

function SectionList({ current, onPick, dense }: { current: SectionId | null; onPick: (id: SectionId) => void; dense: boolean }) {
  const groups = [...new Set(SECTIONS.map((section) => section.group))];
  return (
    <List component="nav" aria-label="Settings pages" sx={{ py: 0 }}>
      {groups.map((group) => (
        <Box key={group} component="li" sx={{ listStyle: "none" }}>
          <ListSubheader disableSticky sx={{ bgcolor: "transparent", lineHeight: 2.5, fontWeight: 600, letterSpacing: 0.3 }}>
            {group}
          </ListSubheader>
          <Box component="ul" sx={{ p: 0, m: 0 }}>
            {SECTIONS.filter((section) => section.group === group).map((section) => {
              const Icon = section.icon;
              return (
                <ListItemButton
                  component="li"
                  key={section.id}
                  selected={current === section.id}
                  onClick={() => onPick(section.id)}
                  aria-current={current === section.id ? "page" : undefined}
                  sx={{ mb: 0.25, py: dense ? 0.75 : 1.1, mx: 0.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 36, color: current === section.id ? "primary.main" : "text.secondary" }}>
                    <Icon />
                  </ListItemIcon>
                  <ListItemText
                    primary={section.label}
                    secondary={dense ? undefined : section.hint}
                    slotProps={{ primary: { fontWeight: 600 }, secondary: { variant: "body2" } }}
                  />
                  {!dense && (
                    <Box sx={{ color: "text.secondary", display: "flex" }}>
                      <NextIcon fontSize="small" />
                    </Box>
                  )}
                </ListItemButton>
              );
            })}
          </Box>
        </Box>
      ))}
    </List>
  );
}

function Brand() {
  return (
    <Stack direction="row" spacing={1.25} alignItems="center">
      <Box component="img" src="/icons/icon48.png" alt="" sx={{ width: 32, height: 32, borderRadius: 1.5 }} />
      <Box>
        <Typography variant="subtitle1" lineHeight={1.2}>
          BrowserHarness
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Settings
        </Typography>
      </Box>
    </Stack>
  );
}

/**
 * mode "page": the big Settings tab. mode "panel": inside the side panel,
 * where onClose goes back to the chat.
 */
export function SettingsShell({
  mode,
  initialSection,
  actions,
  onClose,
  onSectionChange
}: {
  mode: "page" | "panel";
  initialSection?: SectionId;
  actions: SettingsActions;
  onClose?: () => void;
  onSectionChange?: (section: SectionId) => void;
}) {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("md")) && mode === "page";
  const [section, setSection] = useState<SectionId | null>(initialSection ?? (wide ? "home" : null));

  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  const go = (next: SectionId) => {
    setSection(next);
    onSectionChange?.(next);
    window.scrollTo({ top: 0 });
  };

  const props: SectionProps = { go, actions, compact: !wide };
  const openBig = () =>
    void chrome.tabs.create({ url: chrome.runtime.getURL(`settings.html${section ? `#${section}` : ""}`) });

  if (wide) {
    return (
      <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
        <Box
          component="aside"
          sx={{
            width: 300,
            flexShrink: 0,
            borderRight: 1,
            borderColor: "divider",
            bgcolor: "background.paper",
            position: "sticky",
            top: 0,
            height: "100vh",
            overflowY: "auto",
            px: 1,
            py: 2
          }}
        >
          <Box px={1.5} pb={1.5}>
            <Brand />
          </Box>
          <SectionList current={section ?? "home"} onPick={go} dense />
        </Box>
        <Box component="main" sx={{ flex: 1, minWidth: 0, px: { md: 5, lg: 7 }, py: 4 }}>
          <Box sx={{ maxWidth: 860 }}><SectionPage id={section ?? "home"} props={props} /></Box>
        </Box>
      </Box>
    );
  }

  const header = (title: ReactNode, back: (() => void) | undefined, backLabel: string) => (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        px: 1,
        py: 1,
        bgcolor: "background.default",
        borderBottom: 1,
        borderColor: "divider"
      }}
    >
      {back && (
        <Tooltip title={backLabel}>
          <IconButton onClick={back} aria-label={backLabel}>
            <BackIcon />
          </IconButton>
        </Tooltip>
      )}
      <Typography variant="h6" sx={{ flex: 1, minWidth: 0 }} noWrap>
        {title}
      </Typography>
      {mode === "panel" && (
        <Tooltip title="Open Settings in a big tab, with more room">
          <Button size="small" startIcon={<OpenIcon fontSize="small" />} onClick={openBig}>
            Bigger
          </Button>
        </Tooltip>
      )}
    </Stack>
  );

  if (!section) {
    return (
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
        {header("Settings", onClose, "Back to chat")}
        <Box px={1} py={1}>
          <SectionList current={null} onPick={go} dense={false} />
        </Box>
      </Box>
    );
  }

  const info = SECTIONS.find((item) => item.id === section)!;
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      {header(info.label, () => setSection(null), "All settings")}
      <Box px={2} py={2.5}>
        <SectionPage id={section} props={props} />
      </Box>
    </Box>
  );
}
