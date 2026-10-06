export const MAX_POLISH_INPUT_CHARS = 2000;

/**
 * The built-in "better request" skill: what a browser task needs so the
 * agent gets it right the first time.
 */
export const POLISH_SKILL = [
  "A good browser task says:",
  "- where: the website, or this page",
  "- what to find or do",
  "- details that narrow it down: size, colour, budget, dates, place, how many",
  "- what to give back: a short answer, a list, a table, or a filled-in form",
  "- anything it must not do, like buying or sending without asking"
].join("\n");

export interface PolishQuestion {
  question: string;
  /** Likely answers the person can tap. */
  choices: string[];
}

export interface PolishAnswer {
  question: string;
  answer: string;
}

export interface PolishContext {
  /** The tab the task will run on. */
  page?: { title?: string; url?: string };
  /** A saved Skill that looks like this task. */
  skill?: { name: string; instructions: string };
}

/** Ask the model what is still unclear, as a few plain questions with likely answers. */
export function buildQuestionsPrompt(draft: string, context: PolishContext = {}): string {
  const text = draft.trim().slice(0, MAX_POLISH_INPUT_CHARS);
  const lines = [
    "You help a person who is not technical make a browser-task request clearer before an automation agent runs it.",
    POLISH_SKILL,
    "",
    "Ask up to 4 short questions, in plain everyday words, about things the request leaves unclear that would change the result.",
    "Don't ask about anything the request already says. Don't ask for passwords, card numbers or other secrets.",
    "For each question give 2 to 4 likely short answers.",
    "If the request is already clear, return an empty list.",
    'Return only JSON, nothing else: {"questions":[{"question":"...","choices":["...","..."]}]}'
  ];
  if (context.page?.title || context.page?.url) {
    lines.push("", `CURRENT PAGE (the task may be about it): ${[context.page.title, context.page.url].filter(Boolean).join(" — ")}`);
  }
  if (context.skill) {
    lines.push("", `A SAVED SKILL THAT MAY FIT (/${context.skill.name}); ask only what it still needs:`, context.skill.instructions.slice(0, 600));
  }
  lines.push("", `REQUEST:\n${text}`);
  return lines.join("\n");
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Reads the model's questions; anything malformed means "no questions". */
export function parseQuestions(output: string): PolishQuestion[] {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (data as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      question: clip((item as PolishQuestion)?.question, 160),
      choices: Array.isArray((item as PolishQuestion)?.choices)
        ? (item as PolishQuestion).choices.map((choice) => clip(choice, 80)).filter(Boolean).slice(0, 4)
        : []
    }))
    .filter((item) => item.question)
    .slice(0, 4);
}

/** Instruction for the chat model; the user's draft is quoted as data and may not add requirements. */
export function buildPolishPrompt(draft: string, answers: PolishAnswer[] = []): string {
  const text = draft.trim().slice(0, MAX_POLISH_INPUT_CHARS);
  const answered = answers.filter((item) => item.answer.trim());
  return [
    "Rewrite the browser-task request below so it is clear and specific for an automation agent.",
    "Keep the user's intent and every detail they gave. Do not add new goals, sites, steps or permissions. Do not answer the request.",
    ...(answered.length
      ? [
          "The person also answered these questions. Work their answers into the request as details:",
          ...answered.map((item) => `Q: ${item.question.slice(0, 160)}\nA: ${item.answer.trim().slice(0, 300)}`)
        ]
      : []),
    "Return only the rewritten request as plain text, no quotes, no preamble.",
    "",
    `REQUEST:\n${text}`
  ].join("\n");
}

export function cleanPolishedPrompt(
  output: string,
  original: string
): string {
  let text = output.trim();
  text = text.replace(/^```[a-z]*\n?|```$/gi, "").trim();
  text = text.replace(/^(rewritten request|request)\s*:\s*/i, "").trim();
  if (
    text.length > 1 &&
    /^["“].*["”]$/s.test(text)
  ) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length > MAX_POLISH_INPUT_CHARS * 2) return original;
  return text;
}
