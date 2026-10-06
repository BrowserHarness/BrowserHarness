import { alpha, createTheme } from "@mui/material/styles";
import type { PaletteMode } from "@mui/material";
import type { AppearanceMode, TextSize } from "../settings/preferences";

export function resolvePaletteMode(
  appearance: AppearanceMode,
  prefersDark: boolean
): PaletteMode {
  if (appearance === "system") {
    return prefersDark ? "dark" : "light";
  }
  return appearance;
}

/** Base text size in pixels for each "Text size" choice. */
export const TEXT_SIZES: Record<TextSize, number> = {
  normal: 14,
  large: 16,
  larger: 18
};

const BRAND = "#4F46E5";
/** Poppins for headings; Inter for body text, buttons and every other element. */
export const HEADING = '"Poppins", system-ui, sans-serif';

export function createBrowserHarnessTheme(mode: PaletteMode, textSize: TextSize = "normal") {
  const dark = mode === "dark";
  const base = TEXT_SIZES[textSize] ?? TEXT_SIZES.normal;
  const background = dark ? "#0E1015" : "#F6F7FB";
  const paper = dark ? "#161922" : "#FFFFFF";
  const border = dark ? "rgba(255,255,255,0.10)" : "rgba(17,24,39,0.10)";
  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: { main: dark ? "#8B85FF" : BRAND, contrastText: "#FFFFFF" },
      secondary: { main: dark ? "#2DD4BF" : "#0F9F8F" },
      success: { main: dark ? "#34D399" : "#15803D" },
      warning: { main: dark ? "#FBBF24" : "#B45309" },
      error: { main: dark ? "#F87171" : "#B91C1C" },
      info: { main: dark ? "#60A5FA" : "#1D4ED8" },
      background: { default: background, paper },
      divider: border,
      text: dark
        ? { primary: "#F3F4F6", secondary: "#A1A7B3" }
        : { primary: "#111827", secondary: "#4B5563" }
    },
    shape: { borderRadius: 12 },
    typography: {
      fontSize: base,
      htmlFontSize: 16,
      fontFamily: '"Inter", system-ui, sans-serif',
      h1: { fontFamily: HEADING, fontWeight: 600 },
      h2: { fontFamily: HEADING, fontWeight: 600 },
      h3: { fontFamily: HEADING, fontWeight: 600 },
      h4: { fontFamily: HEADING, fontWeight: 600, letterSpacing: "-0.01em" },
      h5: { fontFamily: HEADING, fontWeight: 600, letterSpacing: "-0.01em" },
      h6: { fontFamily: HEADING, fontWeight: 600 },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      body2: { lineHeight: 1.55 },
      button: { textTransform: "none", fontWeight: 600 }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundColor: background },
          "::selection": { backgroundColor: alpha(BRAND, 0.25) }
        }
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 10, paddingInline: 16 },
          sizeSmall: { paddingInline: 12 }
        }
      },
      MuiPaper: {
        styleOverrides: {
          outlined: { borderColor: border },
          rounded: { borderRadius: 16 }
        }
      },
      MuiAlert: { styleOverrides: { root: { borderRadius: 12, alignItems: "flex-start" } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiSwitch: {
        styleOverrides: {
          root: { padding: 8 },
          track: { borderRadius: 22 / 2 }
        }
      },
      MuiListItemButton: { styleOverrides: { root: { borderRadius: 10 } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 18 } } }
    }
  });
}
