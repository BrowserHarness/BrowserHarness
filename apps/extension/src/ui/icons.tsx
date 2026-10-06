import type { ComponentType } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  History,
  Mic,
  Brain,
  BookMarked,
  Upload,
  Pencil,
  Play,
  Volume2,
  Download,
  Pause,
  Plus,
  RefreshCw,
  RotateCcw,
  SendHorizontal,
  Settings,
  Square,
  Trash2,
  WandSparkles,
  Sparkles,
  ShieldCheck,
  Smartphone,
  Plug,
  Palette,
  Lock,
  CircleHelp,
  House,
  CalendarClock,
  UserRound,
  Copy,
  ExternalLink,
  TriangleAlert,
  Lightbulb,
  CircleCheck,
  CircleX,
  Info,
  ChevronRight,
  X,
  PanelLeft,
  Maximize2,
  MessageSquare,
  SquarePen,
  Pin,
  PinOff,
  Ellipsis,
  Search,
  Layers,
  FileDown,
  ArchiveRestore,
  type LucideProps
} from "lucide-react";

/**
 * BrowserHarness icon set: Lucide, sized like Material's SvgIcon so existing
 * `fontSize="small"` call sites keep working.
 */
export interface IconProps {
  fontSize?: "small" | "medium";
}

function makeIcon(
  Icon: ComponentType<LucideProps>,
  extra: LucideProps = {}
): ComponentType<IconProps> {
  return function BrowserHarnessIcon({ fontSize = "medium" }: IconProps) {
    return (
      <Icon
        size={fontSize === "small" ? 18 : 22}
        strokeWidth={2}
        aria-hidden
        {...extra}
      />
    );
  };
}

export const AddIcon = makeIcon(Plus);
export const BackIcon = makeIcon(ArrowLeft);
export const CheckIcon = makeIcon(Check);
export const ChevronDownIcon = makeIcon(ChevronDown);
export const ClearAllIcon = makeIcon(Trash2);
export const DeleteIcon = makeIcon(Trash2);
export const HistoryIcon = makeIcon(History);
export const PauseIcon = makeIcon(Pause, { fill: "currentColor" });
export const PolishIcon = makeIcon(WandSparkles);
export const RecordIcon = makeIcon(Circle, { fill: "currentColor" });
export const RefreshIcon = makeIcon(RefreshCw);
export const ReplayIcon = makeIcon(RotateCcw);
export const SendIcon = makeIcon(SendHorizontal);
export const SettingsIcon = makeIcon(Settings);
export const StopIcon = makeIcon(Square, { fill: "currentColor" });
export const MicIcon = makeIcon(Mic);
export const SpeakIcon = makeIcon(Volume2);
export const DownloadIcon = makeIcon(Download);
export const MemoryIcon = makeIcon(Brain);
export const SkillsIcon = makeIcon(BookMarked);
export const UploadIcon = makeIcon(Upload);
export const EditIcon = makeIcon(Pencil);
export const RunIcon = makeIcon(Play);
export const SparklesIcon = makeIcon(Sparkles);
export const SafetyIcon = makeIcon(ShieldCheck);
export const PhoneIcon = makeIcon(Smartphone);
export const PlugIcon = makeIcon(Plug);
export const PaletteIcon = makeIcon(Palette);
export const LockIcon = makeIcon(Lock);
export const HelpIcon = makeIcon(CircleHelp);
export const HomeIcon = makeIcon(House);
export const ScheduleIcon = makeIcon(CalendarClock);
export const PersonIcon = makeIcon(UserRound);
export const CopyIcon = makeIcon(Copy);
export const OpenIcon = makeIcon(ExternalLink);
export const WarningIcon = makeIcon(TriangleAlert);
export const TipIcon = makeIcon(Lightbulb);
export const YesIcon = makeIcon(CircleCheck);
export const NoIcon = makeIcon(CircleX);
export const InfoIcon = makeIcon(Info);
export const NextIcon = makeIcon(ChevronRight);
export const CloseIcon = makeIcon(X);
export const MenuIcon = makeIcon(PanelLeft);
export const FullPageIcon = makeIcon(Maximize2);
export const ChatIcon = makeIcon(MessageSquare);
export const NewChatIcon = makeIcon(SquarePen);
export const PinIcon = makeIcon(Pin);
export const UnpinIcon = makeIcon(PinOff);
export const MoreIcon = makeIcon(Ellipsis);
export const SearchIcon = makeIcon(Search);
export const SpacesIcon = makeIcon(Layers);
export const SaveFileIcon = makeIcon(FileDown);
export const RestoreIcon = makeIcon(ArchiveRestore);
