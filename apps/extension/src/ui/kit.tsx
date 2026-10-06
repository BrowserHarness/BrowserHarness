// Building blocks for plain-language settings: every setting says what it
// does, what happens when it is on and when it is off, and what we recommend
// (see the grandma-proof copy rulebook).
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  ButtonBase,
  IconButton,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { BackIcon, ChevronDownIcon, CopyIcon, InfoIcon, NoIcon, TipIcon, WarningIcon, YesIcon } from "./icons";

/** The big title at the top of a settings page. */
export function PageTitle({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <Box mb={2.5}>
      <Typography variant="h5" component="h1">
        {title}
      </Typography>
      {intro && (
        <Typography variant="body1" color="text.secondary" mt={0.75} maxWidth={680}>
          {intro}
        </Typography>
      )}
    </Box>
  );
}

/** A group of related settings on a card. */
export function SettingsCard({ title, intro, children, action }: { title?: string; intro?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
      {(title || action) && (
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} mb={intro ? 0.5 : 1.5}>
          {title && (
            <Typography variant="h6" component="h2" fontSize="1.1rem">
              {title}
            </Typography>
          )}
          {action}
        </Stack>
      )}
      {intro && (
        <Typography variant="body2" color="text.secondary" mb={2}>
          {intro}
        </Typography>
      )}
      <Stack spacing={2.5}>{children}</Stack>
    </Paper>
  );
}

type NoteKind = "tip" | "warning" | "info" | "success" | "danger";

/** A coloured box: tips in blue, warnings in orange, good news in green, risks in red. */
export function Note({ kind = "info", title, children }: { kind?: NoteKind; title?: ReactNode; children?: ReactNode }) {
  const theme = useTheme();
  const color = {
    tip: theme.palette.info.main,
    info: theme.palette.info.main,
    warning: theme.palette.warning.main,
    success: theme.palette.success.main,
    danger: theme.palette.error.main
  }[kind];
  const Icon = kind === "tip" ? TipIcon : kind === "warning" || kind === "danger" ? WarningIcon : kind === "success" ? YesIcon : InfoIcon;
  return (
    <Box
      role={kind === "warning" || kind === "danger" ? "alert" : "note"}
      sx={{
        display: "flex",
        gap: 1.25,
        p: 1.5,
        borderRadius: 2,
        bgcolor: alpha(color, theme.palette.mode === "dark" ? 0.14 : 0.08),
        border: `1px solid ${alpha(color, 0.3)}`
      }}
    >
      <Box sx={{ color, mt: "1px", flexShrink: 0 }}>
        <Icon fontSize="small" />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        {title && (
          <Typography variant="body2" fontWeight={600} mb={children ? 0.25 : 0}>
            {title}
          </Typography>
        )}
        {children && (
          <Typography variant="body2" component="div" color="text.primary">
            {children}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/** "Recommended" badge. */
export function RecommendedBadge({ label = "Recommended" }: { label?: string }) {
  return <Chip size="small" color="success" variant="outlined" label={label} sx={{ height: 22 }} />;
}

/** What happens when on, when off, and what we suggest. */
export function Outcomes({ whenOn, whenOff, recommended }: { whenOn?: ReactNode; whenOff?: ReactNode; recommended?: ReactNode }) {
  const theme = useTheme();
  const line = (icon: ReactNode, color: string, title: string, text: ReactNode) => (
    <Stack direction="row" spacing={1} alignItems="flex-start">
      <Box sx={{ color, mt: "2px", flexShrink: 0 }}>{icon}</Box>
      <Typography variant="body2">
        <Box component="span" fontWeight={600}>
          {title}
        </Box>{" "}
        {text}
      </Typography>
    </Stack>
  );
  return (
    <Stack spacing={0.75} sx={{ pl: { xs: 0, sm: 0.25 } }}>
      {whenOn && line(<YesIcon fontSize="small" />, theme.palette.success.main, "When on:", whenOn)}
      {whenOff && line(<NoIcon fontSize="small" />, theme.palette.text.secondary, "When off:", whenOff)}
      {recommended && line(<TipIcon fontSize="small" />, theme.palette.info.main, "Our advice:", recommended)}
    </Stack>
  );
}

/** An on/off setting with its plain-language explanation. */
export function ToggleSetting({
  label,
  help,
  whenOn,
  whenOff,
  recommended,
  warning,
  technicalName,
  checked,
  disabled,
  onChange
}: {
  label: string;
  help: ReactNode;
  whenOn: ReactNode;
  whenOff: ReactNode;
  recommended: ReactNode;
  warning?: ReactNode;
  technicalName?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <Box>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
        <Box sx={{ minWidth: 0 }}>
          <Typography id={`${id}-label`} variant="subtitle1" component="label" htmlFor={id} sx={{ cursor: "pointer", display: "block" }}>
            {label}
          </Typography>
          <Typography variant="body2" color="text.secondary" mt={0.25}>
            {help}
          </Typography>
        </Box>
        <Stack alignItems="center" sx={{ flexShrink: 0 }}>
          <Switch
            id={id}
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
            slotProps={{ input: { "aria-labelledby": `${id}-label` } }}
          />
          <Typography variant="caption" color={checked ? "success.main" : "text.secondary"} fontWeight={600} aria-hidden>
            {checked ? "ON" : "OFF"}
          </Typography>
        </Stack>
      </Stack>
      <Box mt={1.25}>
        <Outcomes whenOn={whenOn} whenOff={whenOff} recommended={recommended} />
      </Box>
      {warning && (
        <Box mt={1.25}>
          <Note kind="warning">{warning}</Note>
        </Box>
      )}
      {technicalName && <TechnicalName name={technicalName} />}
    </Box>
  );
}

export interface Choice<T extends string> {
  value: T;
  title: string;
  description: ReactNode;
  recommended?: boolean;
  warning?: ReactNode;
}

/** A choice between a few options, each explained, the recommended one marked. */
export function ChoiceCards<T extends string>({
  label,
  help,
  choices,
  value,
  onChange,
  columns = 1
}: {
  label: string;
  help?: ReactNode;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  columns?: 1 | 2 | 3;
}) {
  const theme = useTheme();
  const groupId = useId();
  const selected = choices.find((choice) => choice.value === value);
  return (
    <Box role="radiogroup" aria-labelledby={`${groupId}-label`}>
      <Typography id={`${groupId}-label`} variant="subtitle1">
        {label}
      </Typography>
      {help && (
        <Typography variant="body2" color="text.secondary" mt={0.25}>
          {help}
        </Typography>
      )}
      <Box
        mt={1.5}
        sx={{
          display: "grid",
          gap: 1.25,
          gridTemplateColumns: { xs: "1fr", md: `repeat(${columns}, minmax(0, 1fr))` }
        }}
      >
        {choices.map((choice) => {
          const active = choice.value === value;
          return (
            <ButtonBase
              key={choice.value}
              role="radio"
              aria-checked={active}
              aria-label={choice.title}
              onClick={() => onChange(choice.value)}
              sx={{
                textAlign: "left",
                display: "block",
                p: 1.75,
                borderRadius: 3,
                border: `2px solid ${active ? theme.palette.primary.main : theme.palette.divider}`,
                bgcolor: active ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.14 : 0.06) : "transparent",
                transition: "border-color .15s, background-color .15s",
                "&:hover": { borderColor: active ? theme.palette.primary.main : alpha(theme.palette.primary.main, 0.5) },
                "&.Mui-focusVisible": { outline: `3px solid ${alpha(theme.palette.primary.main, 0.4)}` }
              }}
            >
              <Stack direction="row" spacing={1.25} alignItems="flex-start">
                <Box
                  aria-hidden
                  sx={{
                    mt: "3px",
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                    borderRadius: "50%",
                    border: `2px solid ${active ? theme.palette.primary.main : theme.palette.text.secondary}`,
                    display: "grid",
                    placeItems: "center"
                  }}
                >
                  {active && <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main" }} />}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle2" fontSize="0.98rem">
                      {choice.title}
                    </Typography>
                    {choice.recommended && <RecommendedBadge />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary" mt={0.25}>
                    {choice.description}
                  </Typography>
                </Box>
              </Stack>
            </ButtonBase>
          );
        })}
      </Box>
      {selected?.warning && (
        <Box mt={1.5}>
          <Note kind="warning" title="Please read">
            {selected.warning}
          </Note>
        </Box>
      )}
    </Box>
  );
}

/** Numbered steps. */
export function Steps({ steps }: { steps: ReactNode[] }) {
  return (
    <Stack component="ol" spacing={1.25} sx={{ listStyle: "none", p: 0, m: 0 }}>
      {steps.map((step, index) => (
        <Stack component="li" key={index} direction="row" spacing={1.25} alignItems="flex-start">
          <Box
            aria-hidden
            sx={{
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              bgcolor: "primary.main",
              color: "primary.contrastText",
              display: "grid",
              placeItems: "center",
              fontSize: 13,
              fontWeight: 700
            }}
          >
            {index + 1}
          </Box>
          <Typography variant="body2" component="div" sx={{ pt: "3px", minWidth: 0, flex: 1 }}>
            {step}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

/** Something to type into a terminal, with a Copy button. */
export function CopyBox({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        mt: 0.75,
        p: 1,
        pl: 1.5,
        borderRadius: 2,
        bgcolor: theme.palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(17,24,39,0.05)",
        border: `1px solid ${theme.palette.divider}`
      }}
    >
      <Typography component="code" sx={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "0.85em", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {text}
      </Typography>
      <Tooltip title={copied ? "Copied" : "Copy to paste it"}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<CopyIcon fontSize="small" />}
          aria-label={`${label}: ${text}`}
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : label}
        </Button>
      </Tooltip>
    </Stack>
  );
}

/** Extra detail people can open if they want it. */
export function MoreDetails({ summary = "More about this", children }: { summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Button
        size="small"
        variant="text"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        endIcon={
          <Box component="span" sx={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
            <ChevronDownIcon fontSize="small" />
          </Box>
        }
        sx={{ px: 0.5, ml: -0.5 }}
      >
        {summary}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box pt={1}>{children}</Box>
      </Collapse>
    </Box>
  );
}

/** The technical word, for people who are helping someone set it up. */
export function TechnicalName({ name }: { name: string }) {
  return (
    <Typography variant="caption" color="text.secondary" display="block" mt={1}>
      Technical name: {name} (you don't need to know this)
    </Typography>
  );
}

/** A coloured dot and a short status, like "Connected" or "Not set up yet". */
export function StatusPill({ state, children }: { state: "good" | "waiting" | "off" | "problem"; children: ReactNode }) {
  const theme = useTheme();
  const color = {
    good: theme.palette.success.main,
    waiting: theme.palette.warning.main,
    off: theme.palette.text.secondary,
    problem: theme.palette.error.main
  }[state];
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ color, flexShrink: 0 }}>
      <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: color }} />
      <Typography variant="body2" fontWeight={600} color="inherit">
        {children}
      </Typography>
    </Stack>
  );
}

interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** "Are you sure?" before anything that can't be undone. */
export function useConfirm(): [ReactNode, (request: ConfirmRequest) => Promise<boolean>] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const confirm = useCallback((next: ConfirmRequest) => {
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const close = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  };
  const dialog = (
    <Dialog open={Boolean(request)} onClose={() => close(false)} maxWidth="xs" fullWidth>
      {request && (
        <>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogContent>
            <Typography variant="body2" component="div">
              {request.body}
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => close(false)}>{request.cancelLabel || "No, keep it"}</Button>
            <Button variant="contained" color={request.danger ? "error" : "primary"} onClick={() => close(true)}>
              {request.confirmLabel}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
  return [dialog, confirm];
}

/** A screen of its own in the side panel, or a page inside Settings (embedded). */
export function ScreenFrame({
  title,
  intro,
  embedded,
  onBack,
  action,
  children
}: {
  title: string;
  intro?: ReactNode;
  embedded?: boolean;
  onBack: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  if (embedded) {
    return (
      <>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1}>
          <PageTitle title={title} intro={intro} />
          {action}
        </Stack>
        {children}
      </>
    );
  }
  return (
    <Box sx={{ minHeight: "100vh", p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={1}>
        <IconButton onClick={onBack} aria-label="Back to chat">
          <BackIcon />
        </IconButton>
        <Typography variant="h6" component="h1" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {action}
      </Stack>
      {intro && (
        <Typography variant="body2" color="text.secondary" mb={2}>
          {intro}
        </Typography>
      )}
      {children}
      <Button sx={{ mt: 2 }} onClick={onBack}>
        Back to chat
      </Button>
    </Box>
  );
}

