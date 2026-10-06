// Is a remembered thing useful for this request? Deterministic word and
// topic matching, so the same request always gets the same memory.
import { contentWords } from "../skill-learning";

/** Groups of words that point at the same need. A request word in a group makes the group's topics relevant. */
const CONCEPTS: Array<{ words: string[]; topics: string[]; subjects: string[] }> = [
  {
    // Where the person is: local searches, travel, deliveries, weather.
    words: "near nearby local around city town area weather restaurant restaurants lunch dinner breakfast cafe cafes food eat deliver delivery shop shops store stores travel trip flight flights train hotel hotels visit commute address live based home moved move".split(" "),
    topics: ["home", "work", "timezone"],
    subjects: ["address", "location", "city", "neighbourhood"]
  },
  {
    // Money and buying.
    words: "price prices cost costs cheap cheapest buy buying order shop shopping budget pay payment spend rupee rupees dollar dollars currency deal deals afford".split(" "),
    topics: ["currency", "budget"],
    subjects: ["currency", "budget", "payment", "shop platform", "store platform"]
  },
  {
    // Words and language.
    words: "write writing translate reply answer answers email letter message language speak post caption".split(" "),
    topics: ["language"],
    subjects: ["language", "tone", "style", "format"]
  },
  {
    // Speaking as the person or about them: their name goes on it.
    words: "email emails letter letters bio biography introduce introduc introduction intro signature sign form forms fill profile cv resume cover application apply register registration signup invitation invite greet".split(" "),
    topics: ["name", "nickname"],
    subjects: []
  },
  {
    // Work and code.
    words: "code repo repository push pull commit branch release deploy deployment publish host hosting server ci build github gitlab forgejo website site domain".split(" "),
    topics: ["work"],
    subjects: ["code", "repo", "deploy", "deployment", "hosting", "host", "platform", "release", "domain", "website", "site"]
  },
  {
    // Time.
    words: "today tomorrow schedule meeting meetings calendar remind reminder time timezone morning evening".split(" "),
    topics: ["timezone", "home"],
    subjects: ["timezone", "schedule", "calendar"]
  }
];

/**
 * Shapes every reply, so it always comes along. A name does not: it goes only
 * with requests that speak as or about the person (an email or letter from
 * them, a bio, an introduction, a form to fill), by the identity group above.
 */
export const ALWAYS_USEFUL_TOPICS = new Set(["language"]);

function conceptsIn(words: Set<string>): typeof CONCEPTS {
  return CONCEPTS.filter((concept) => concept.words.some((word) => words.has(word) || words.has(word.replace(/s$/, ""))));
}

/** Shared meaningful words between a request and a remembered line, 0 to 1. */
export function overlap(request: string, text: string): number {
  const asked = contentWords(request);
  const known = contentWords(text);
  if (!asked.size || !known.size) return 0;
  let shared = 0;
  for (const word of known) if (asked.has(word)) shared += 1;
  return Math.min(1, shared / Math.min(asked.size, known.size));
}

/** How the person wants answers ("Keep answers concise", "I prefer a formal tone"): it shapes every reply. */
const HOW_TO_ANSWER = /\b(answers?|repl(y|ies)|respon(d|ses?)|tone|concise|brief|short|detailed|formal|casual|explain|explanations?|plain (english|words|language)|bullet points?)\b/i;

/** How useful a current fact is for a request (0 = leave it out), and why. */
export function factUsefulness(request: string, text: string, topic?: string): { score: number; reason: string } {
  if (topic && ALWAYS_USEFUL_TOPICS.has(topic)) return { score: 0.9, reason: "the language you use (always useful)" };
  if (HOW_TO_ANSWER.test(text)) return { score: 0.8, reason: "how you like answers (always useful)" };
  const words = contentWords(request);
  const byWords = overlap(request, text);
  if (byWords > 0) return { score: Math.min(1, 0.5 + byWords / 2), reason: "shares words with the request" };
  if (topic && conceptsIn(words).some((concept) => concept.topics.includes(topic.replace(/^favourite:/, "")))) {
    return { score: 0.5, reason: `the request needs your ${topic}` };
  }
  return { score: 0, reason: "not relevant to this request" };
}

/** How useful a current decision is for a request. */
export function decisionUsefulness(request: string, subject: string, value: string): { score: number; reason: string } {
  const byWords = overlap(request, `${subject} ${value}`);
  if (byWords > 0) return { score: Math.min(1, 0.5 + byWords / 2), reason: "shares words with the request" };
  const lower = ` ${subject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  if (conceptsIn(contentWords(request)).some((concept) => concept.subjects.some((word) => lower.includes(` ${word} `)))) {
    return { score: 0.5, reason: "about what the request is doing" };
  }
  return { score: 0, reason: "not relevant to this request" };
}

/** Topic-group words for a past question ("based", "moved" for a home). */
export function conceptTopicsFor(request: string): Set<string> {
  return new Set(conceptsIn(contentWords(request)).flatMap((concept) => concept.topics));
}

/** Words that point back at the chat rather than say what about. */
const POINTING = new Set("it that this those these them one ones first second third last previous other format shorter longer simpler again instead same make use do compare".split(" "));

/**
 * A follow-up that only makes sense with the chat so far ("make it shorter",
 * "compare that with the second one", "use the previous format"): it points
 * back and says little of its own. "Open this page and check the kettle"
 * says plenty, so it is not one.
 */
export function isFollowUp(request: string): boolean {
  const value = request.trim().toLowerCase();
  if (!/^(and |also |now |then |ok(ay)?,? |what about |how about )|\b(it|that|those|them|the (first|second|third|last|previous|other) (one|option|result)s?|the previous (format|answer|one)|shorter|longer|simpler|instead)\b/.test(value)) {
    return false;
  }
  const own = [...contentWords(value)].filter((word) => !POINTING.has(word));
  return own.length <= 2;
}
