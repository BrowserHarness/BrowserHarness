// Small moments that tell people what just happened: a tick when something
// connects, a clear card with the reason and the fix when it can't, and a
// "Saved" note when a setting changes.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Button, Collapse, Paper, Slide, Snackbar, Stack, Typography } from "@mui/material";
import { alpha, keyframes, useTheme } from "@mui/material/styles";
import { OpenIcon, WarningIcon, YesIcon } from "./icons";
import type { Problem } from "../help/problems";
import { guideUrl } from "../help/links";

const pop = keyframes`
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.12); opacity: 1; }
  100% { transform: scale(1); }
`;
const draw = keyframes`to { stroke-dashoffset: 0; }`;
const ring = keyframes`
  0% { box-shadow: 0 0 0 0 var(--ring); }
  100% { box-shadow: 0 0 0 14px transparent; }
`;
const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
`;
const noMotion = { "@media (prefers-reduced-motion: reduce)": { animation: "none !important", strokeDashoffset: 0 } };

/** A green circle whose tick draws itself. */
export function SuccessCheck({ size = 44 }: { size?: number }) {
  const theme = useTheme();
  const color = theme.palette.success.main;
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "50%",
        bgcolor: color,
        display: "grid",
        placeItems: "center",
        "--ring": alpha(color, 0.45),
        animation: `${pop} .42s cubic-bezier(.2,.9,.3,1.3) both, ${ring} .9s .3s ease-out`,
        ...noMotion
      }}
    >
      <Box component="svg" viewBox="0 0 24 24" sx={{ width: size * 0.55, height: size * 0.55 }}>
        <Box
          component="path"
          d="M5 12.5l4.2 4.2L19 7"
          sx={{
            fill: "none",
            stroke: "#fff",
            strokeWidth: 3,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            strokeDasharray: 24,
            strokeDashoffset: 24,
            animation: `${draw} .35s .25s ease-out forwards`,
            ...noMotion
          }}
        />
      </Box>
    </Box>
  );
}

/** "Connected" with a tick, and one line about what now works. */
export function SuccessBanner({ title = "Connected", children, action }: { title?: string; children?: ReactNode; action?: ReactNode }) {
  const theme = useTheme();
  return (
    <Paper
      role="status"
      aria-live="polite"
      elevation={0}
      sx={{
        p: 2,
        display: "flex",
        gap: 1.75,
        alignItems: "center",
        border: `1px solid ${alpha(theme.palette.success.main, 0.35)}`,
        bgcolor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.12 : 0.07),
        animation: `${fadeUp} .3s ease-out`,
        ...noMotion
      }}
    >
      <SuccessCheck />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle1" fontWeight={700} color="success.main">
          {title}
        </Typography>
        {children && (
          <Typography variant="body2" component="div">
            {children}
          </Typography>
        )}
      </Box>
      {action}
    </Paper>
  );
}

/** Why something didn't work, what to do, and the guide for more. */
export function ProblemCard({
  problem,
  onRetry,
  retryLabel = "Try again",
  severity = "error",
  heading
}: {
  problem: Problem;
  onRetry?: () => void;
  retryLabel?: string;
  /** "warning" when it partly worked, like an AI that can chat but not use the browser. */
  severity?: "error" | "warning";
  /** A short lead-in, like "Couldn't connect". */
  heading?: string;
}) {
  const theme = useTheme();
  const color = severity === "error" ? theme.palette.error.main : theme.palette.warning.main;
  const [details, setDetails] = useState(false);
  return (
    <Paper
      role="alert"
      elevation={0}
      sx={{
        p: 2,
        border: `1px solid ${alpha(color, 0.4)}`,
        bgcolor: alpha(color, theme.palette.mode === "dark" ? 0.12 : 0.06),
        animation: `${fadeUp} .3s ease-out`,
        ...noMotion
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Box sx={{ color, mt: "2px", flexShrink: 0 }}>
          <WarningIcon />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {heading && (
            <Typography variant="caption" fontWeight={700} sx={{ color, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {heading}
            </Typography>
          )}
          <Typography variant="subtitle1" fontWeight={700}>
            {problem.title}
          </Typography>
          <Typography variant="body2" mt={0.5}>
            <strong>Why:</strong> {problem.reason}
          </Typography>
          <Typography variant="body2" fontWeight={700} mt={1.25}>
            How to fix it:
          </Typography>
          <Box component="ol" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {problem.fixes.map((fix) => (
              <Typography component="li" variant="body2" key={fix} sx={{ mb: 0.25, overflowWrap: "anywhere" }}>
                {fix}
              </Typography>
            ))}
          </Box>
          <Stack direction="row" spacing={1} mt={1.5} flexWrap="wrap" useFlexGap>
            {onRetry && (
              <Button variant="contained" color={severity === "error" ? "error" : "warning"} onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            <Button
              variant="outlined"
              color="inherit"
              endIcon={<OpenIcon fontSize="small" />}
              href={guideUrl(problem.guide)}
              target="_blank"
              rel="noopener"
              data-guide={problem.guide}
            >
              Read the guide
            </Button>
          </Stack>
          {problem.detail && (
            <Box mt={1}>
              <Button size="small" color="inherit" sx={{ px: 0.5, opacity: 0.8 }} onClick={() => setDetails((open) => !open)} aria-expanded={details}>
                {details ? "Hide details" : "Show details for someone helping you"}
              </Button>
              <Collapse in={details} unmountOnExit>
                <Typography
                  variant="caption"
                  component="pre"
                  sx={{ mt: 0.5, p: 1, borderRadius: 1, bgcolor: "action.hover", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}
                >
                  {problem.detail}
                </Typography>
              </Collapse>
            </Box>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

type Notify = (message?: string) => void;
const SavedContext = createContext<Notify>(() => undefined);

/** Shows a short "Saved" note at the bottom whenever a page calls useSaved(). */
export function SavedNotes({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<{ text: string; key: number } | null>(null);
  const notify = useCallback<Notify>((message = "Saved") => setNote({ text: message, key: Date.now() }), []);
  return (
    <SavedContext.Provider value={notify}>
      {children}
      <Snackbar
        key={note?.key}
        open={Boolean(note)}
        autoHideDuration={2200}
        onClose={() => setNote(null)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        slots={{ transition: Slide }}
        slotProps={{ transition: { direction: "down" } as object }}
      >
        <Paper
          role="status"
          elevation={6}
          sx={{ px: 2, py: 1.1, borderRadius: 999, display: "flex", alignItems: "center", gap: 1, bgcolor: "text.primary", color: "background.paper" }}
        >
          <Box component="span" sx={{ color: "success.light", display: "inline-flex" }}>
            <YesIcon fontSize="small" />
          </Box>
          <Typography variant="body2" fontWeight={600} data-testid="saved-note">
            {note?.text}
          </Typography>
        </Paper>
      </Snackbar>
    </SavedContext.Provider>
  );
}

/** Call the returned function after saving a setting. */
export function useSaved(): Notify {
  return useContext(SavedContext);
}

/** True for a moment after `value` turns true, for one-off celebrations. */
export function useJustBecame(value: boolean, ms = 6000): boolean {
  const previous = useRef(value);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (value && !previous.current) {
      setFresh(true);
      const timer = setTimeout(() => setFresh(false), ms);
      previous.current = value;
      return () => clearTimeout(timer);
    }
    previous.current = value;
  }, [value, ms]);
  return fresh;
}
