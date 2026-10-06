// "Improve my request": the current AI reads the request, asks a few plain
// questions with tap-to-fill answers, then rewrites the request with them.
import { useEffect, useRef, useState } from "react";
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { PolishIcon } from "./icons";
import { Waiting } from "./SimpleConnect";
import { ProblemCard } from "./feedback";
import { diagnoseAi, type AiContext } from "../help/problems";
import {
  buildPolishPrompt,
  buildQuestionsPrompt,
  cleanPolishedPrompt,
  parseQuestions,
  type PolishContext,
  type PolishQuestion
} from "../runtime/prompt-polish";

type Step =
  | { kind: "reading" }
  | { kind: "questions"; questions: PolishQuestion[] }
  | { kind: "improving" }
  | { kind: "error"; error: unknown; retry: () => void };

export function PolishDialog({
  open,
  draft,
  context,
  ai,
  ask,
  onClose,
  onDone
}: {
  open: boolean;
  draft: string;
  context: PolishContext;
  /** Which AI is answering, so a failure can say what to fix. */
  ai: AiContext;
  /** Sends one prompt to the AI picked in the chat and returns its reply. */
  ask: (prompt: string) => Promise<string>;
  onClose: () => void;
  onDone: (improved: string, answered: number) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "reading" });
  const [answers, setAnswers] = useState<string[]>([]);
  const run = useRef(0);

  const improve = async (questions: PolishQuestion[], given: string[]) => {
    const id = ++run.current;
    setStep({ kind: "improving" });
    const pairs = questions.map((item, index) => ({ question: item.question, answer: given[index] || "" }));
    try {
      const reply = await ask(buildPolishPrompt(draft, pairs));
      if (id !== run.current) return;
      onDone(cleanPolishedPrompt(reply, draft), pairs.filter((pair) => pair.answer.trim()).length);
    } catch (error) {
      if (id === run.current) setStep({ kind: "error", error, retry: () => void improve(questions, given) });
    }
  };

  const readRequest = async () => {
    const id = ++run.current;
    setStep({ kind: "reading" });
    setAnswers([]);
    try {
      const questions = parseQuestions(await ask(buildQuestionsPrompt(draft, context)));
      if (id !== run.current) return;
      if (questions.length === 0) {
        // Already clear: just tidy the wording.
        await improve([], []);
        return;
      }
      setAnswers(questions.map(() => ""));
      setStep({ kind: "questions", questions });
    } catch (error) {
      if (id === run.current) setStep({ kind: "error", error, retry: () => void readRequest() });
    }
  };

  useEffect(() => {
    if (open) void readRequest();
    else run.current++;
    // A new draft or a reopened dialog starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setAnswer = (index: number, value: string) =>
    setAnswers((items) => items.map((item, at) => (at === index ? value : item)));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="polish-title">
      <DialogTitle id="polish-title" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <PolishIcon fontSize="small" />
        Improve my request
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, p: 1.25, borderRadius: 1.5, bgcolor: "action.hover", overflowWrap: "anywhere" }}>
          “{draft.length > 240 ? `${draft.slice(0, 240)}…` : draft}”
        </Typography>
        {step.kind === "reading" && <Waiting>Reading your request…</Waiting>}
        {step.kind === "improving" && <Waiting>Rewriting your request…</Waiting>}
        {step.kind === "error" && (
          <ProblemCard problem={diagnoseAi(step.error, ai)} heading="Couldn't improve it" onRetry={step.retry} />
        )}
        {step.kind === "questions" && (
          <Stack spacing={2.25}>
            <Typography variant="body2">
              A few quick questions make the result better. Answer the ones you can. Tap a suggestion, or type your own.
            </Typography>
            {step.questions.map((item, index) => (
              <Box key={item.question} data-polish-question={index}>
                <Typography variant="subtitle2" fontWeight={700} mb={0.75}>
                  {item.question}
                </Typography>
                {item.choices.length > 0 && (
                  <Stack direction="row" gap={0.75} flexWrap="wrap" mb={1}>
                    {item.choices.map((choice) => (
                      <Chip
                        key={choice}
                        label={choice}
                        size="small"
                        color={answers[index] === choice ? "primary" : "default"}
                        variant={answers[index] === choice ? "filled" : "outlined"}
                        onClick={() => setAnswer(index, answers[index] === choice ? "" : choice)}
                      />
                    ))}
                  </Stack>
                )}
                <TextField
                  size="small"
                  fullWidth
                  placeholder="Your answer (optional)"
                  value={answers[index] || ""}
                  onChange={(event) => setAnswer(index, event.target.value)}
                  inputProps={{ "aria-label": item.question }}
                />
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, flexWrap: "wrap", gap: 1 }}>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        {step.kind === "questions" && (
          <>
            <Button onClick={() => void improve(step.questions, [])}>Skip questions</Button>
            <Button variant="contained" startIcon={<PolishIcon fontSize="small" />} onClick={() => void improve(step.questions, answers)}>
              Improve my request
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
