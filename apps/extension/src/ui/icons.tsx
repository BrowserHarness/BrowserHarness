import type { ComponentType } from "react";
import {
  ArrowLeft,
  Circle,
  History,
  Pause,
  Plus,
  RefreshCw,
  RotateCcw,
  SendHorizontal,
  Settings,
  Square,
  Trash2,
  WandSparkles,
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
