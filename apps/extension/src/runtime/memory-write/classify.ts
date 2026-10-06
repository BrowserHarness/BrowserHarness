// What kind of memory a statement is, and how sure the person sounded.
// Fixed word rules only: the same words always get the same answer, and
// nothing here needs a model or a network.
import { withoutScopeWords } from "../about-me";
import type { Certainty, Classification } from "./types";

const clean = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.,;:!]+$/, "");

/** Wishing, wondering or planning, not how things are. */
const HYPOTHETICAL =
  /\b(might|maybe|perhaps|possibly|probably|thinking (about|of)|considering|planning to|plan to|hoping to|hope to|want to|wanna|would like to|i'd like to|should i|if i|someday|some day|one day|could|wondering)\b|\?\s*$/i;
/** "may" as a maybe, not the month. */
const MAY = /\bmay\b/;
/** True for a while only. */
const TEMPORARY =
  /\bfor (a |the |two |three |four |five |a few |a couple of |\d+ )?(couple of )?(days?|nights?|weeks?|weekend|hours?)\b|\b(this|next) (week|weekend)\b|\b(today|tonight|tomorrow|right now|at the moment)\b|\bcurrently (visiting|travel?ling|staying)\b|\bvisiting\b|\bon (a |my )?(trip|holiday|vacation|business trip)\b|\bstaying (at|in)\b|\buntil\b/i;

/** A standing instruction: how BrowserHarness should act from now on. */
const IMPERATIVE_START =
  /^(always|never|don't|do not|please|keep|make sure|use|prefer|avoid|only|answer|reply|write|show|give|stop|start|ask( me)?|check|default to|stick to|remember to)\b/i;
/** Words that make a request a standing wish rather than this one task. */
const STANDING =
  /^(always|never)\b|\b(from now on|going forward|in (the )?future|every time|whenever|by default|as a rule|don't ever|do not ever|for (this|the) (space|project|client|team|shop|store)|across all (my )?spaces|in every space)\b/i;

/** Speaking of oneself: a fact. */
const FACT_START =
  /^(my |i |i'm |i've |call me\b|our )/i;
/** Likes, dislikes and choices: a preference. */
const PREFERENCE_START = /^(i (usually |always |generally |mostly )?(prefer|like|love|hate|dislike|enjoy|avoid)|i'd rather|i would rather|i always|i never|i usually|my favou?rite)\b/i;

/** Tools and platforms people decide on, and the subject such a choice is about. */
const PLATFORMS: Array<[RegExp, string, string]> = [
  [/\b(github)\b/i, "GitHub", "Code home"],
  [/\b(gitlab)\b/i, "GitLab", "Code home"],
  [/\b(bitbucket)\b/i, "Bitbucket", "Code home"],
  [/\b(forgejo)\b/i, "Forgejo", "Code home"],
  [/\b(gitea)\b/i, "Gitea", "Code home"],
  [/\b(cloudflare( pages)?)\b/i, "Cloudflare", "Deployment platform"],
  [/\b(vercel)\b/i, "Vercel", "Deployment platform"],
  [/\b(netlify)\b/i, "Netlify", "Deployment platform"],
  [/\b(github pages)\b/i, "GitHub Pages", "Deployment platform"],
  [/\b(aws|amazon web services)\b/i, "AWS", "Deployment platform"],
  [/\b(azure)\b/i, "Azure", "Deployment platform"],
  [/\b(google cloud|gcp)\b/i, "Google Cloud", "Deployment platform"],
  [/\b(heroku)\b/i, "Heroku", "Deployment platform"],
  [/\b(render\.com)\b/i, "Render", "Deployment platform"],
  [/\b(railway)\b/i, "Railway", "Deployment platform"],
  [/\b(digitalocean)\b/i, "DigitalOcean", "Deployment platform"],
  [/\b(hostinger)\b/i, "Hostinger", "Deployment platform"],
  [/\b(stripe)\b/i, "Stripe", "Payments"],
  [/\b(razorpay)\b/i, "Razorpay", "Payments"],
  [/\b(paypal)\b/i, "PayPal", "Payments"],
  [/\b(paddle)\b/i, "Paddle", "Payments"],
  [/\b(slack)\b/i, "Slack", "Team chat"],
  [/\b(discord)\b/i, "Discord", "Team chat"],
  [/\b(microsoft teams)\b/i, "Microsoft Teams", "Team chat"],
  [/\b(notion)\b/i, "Notion", "Docs"],
  [/\b(confluence)\b/i, "Confluence", "Docs"],
  [/\b(jira)\b/i, "Jira", "Task tracking"],
  [/\b(linear)\b/i, "Linear", "Task tracking"],
  [/\b(trello)\b/i, "Trello", "Task tracking"],
  [/\b(asana)\b/i, "Asana", "Task tracking"],
  [/\b(postgres(ql)?)\b/i, "Postgres", "Database"],
  [/\b(mysql)\b/i, "MySQL", "Database"],
  [/\b(mongodb)\b/i, "MongoDB", "Database"],
  [/\b(supabase)\b/i, "Supabase", "Database"],
  [/\b(firebase)\b/i, "Firebase", "Database"],
  [/\b(shopify)\b/i, "Shopify", "Shop platform"],
  [/\b(woocommerce)\b/i, "WooCommerce", "Shop platform"],
  [/\b(figma)\b/i, "Figma", "Design tool"]
];

/** Settled-choice wording. */
const STRONG_DECISION = /\b(from now on|going forward|we('ve| have)? decided|decided to|canonical|official(ly)?|for good|permanently|is our (main|primary|default)|because)\b/i;
/** A choice for the work, not a step of this task. */
const DECISION_PATTERNS: RegExp[] = [
  /\b(let's|let us) (use|go with|switch to|stick with|move to|deploy (on|to)|host (on|with))\b/i,
  /\bwe('ll| will| are going to|'re going to) (use|go with|switch to|stick with|move to|deploy (this |it |everything )?(on|to)|host (this |it )?(on|with))\b/i,
  /\bwe('re| are) (using|going with|switching to|moving to|sticking with|deploying (on|to)|hosting (on|with))\b/i,
  /\bwe('ve| have)? decided (to use|on)\b/i,
  /\bis our (canonical|official|main|primary|default)\b/i,
  /^(use|switch to|go with) .{2,40} for (this|our|the) (project|space|team|work|company|app|site|website|repo|code|codebase)\b/i,
  /\bfrom now on,? (use|we use)\b/i
];

function platformIn(text: string): { value: string; subject: string } | null {
  for (const [pattern, value, subject] of PLATFORMS) if (pattern.test(text)) return { value, subject };
  return null;
}

/** "Postgres is our canonical database" → subject "Database"; "use Mongo for the cache" → "Cache". */
function namedSubject(text: string): string | null {
  const our = /\bis our (?:canonical|official|main|primary|default) ([a-z][a-z ]{2,30}?)(?=\b(because|since|as|for)\b|[.,;!]|$)/i.exec(text);
  const forWhat = /\bfor (?:the |our )?([a-z][a-z ]{2,30}?)(?=\b(from|because|since|going|now)\b|[.,;!]|$)/i.exec(text);
  const raw = our?.[1] ?? forWhat?.[1];
  if (!raw) return null;
  const subject = raw.trim().replace(/^(this|that) /i, "");
  if (/^(this )?(project|space|team|work|company|app|site|website|now|good|me|us|everything|it)$/i.test(subject)) return null;
  return subject.replace(/^./, (first) => first.toUpperCase());
}

/** How sure the person sounded. */
export function certaintyOf(text: string): Certainty {
  if (HYPOTHETICAL.test(text) || MAY.test(text)) return "hypothetical";
  if (TEMPORARY.test(text)) return "temporary";
  return "clear";
}

/** A decision in this sentence: what it's about, what was chosen, and how settled it sounds. */
export function decisionIn(sentence: string): Classification["decision"] | null {
  if (!DECISION_PATTERNS.some((pattern) => pattern.test(sentence))) return null;
  const platform = platformIn(sentence);
  const subject = platform?.subject ?? namedSubject(sentence);
  const value = platform?.value ?? /\b(?:use|with|to|on) ([A-Z][\w.+-]*(?: [A-Z][\w.+-]*){0,2})/.exec(sentence)?.[1] ?? null;
  if (!subject || !value) return null;
  const rationale = /\b(?:because|since) ([^.;!?]{3,120})/i.exec(sentence)?.[1]?.trim();
  return { subject, value, ...(rationale ? { rationale } : {}), strength: STRONG_DECISION.test(sentence) ? "strong" : "moderate" };
}

/**
 * Sorts one statement into a fact, a preference, an instruction, a decision
 * or unknown. `standing` asks whether an imperative must say it is for the
 * future ("always", "from now on", "for this project"): ordinary chat needs
 * that, or every task request ("open amazon and …") would look like a rule.
 */
export function classifyStatement(raw: string, options: { requireStanding?: boolean; saidIn?: string } = {}): Classification {
  const said = clean(raw).replace(/^(please )?remember (that |: ?)?/i, "");
  // "I moved to Mumbai" is where you live now.
  const text = withoutScopeWords(said).replace(/^i(?: have|'ve)? (?:just |recently )?moved to ([\p{L}][\p{L}'’ -]{1,50}?)(?:\s+(?:last|this|a few|recently|in \d).*)?$/iu, "I live in $1");
  const certainty = certaintyOf(said);
  const decision = decisionIn(said);
  if (decision) return { type: "decision", certainty, text, decision, why: `a ${decision.strength} decision about ${decision.subject}` };
  if (PREFERENCE_START.test(text) && !/^i like to be called\b/i.test(text)) return { type: "preference", certainty, text, why: "says what you like or choose" };
  if (FACT_START.test(text)) return { type: "fact", certainty, text, why: "says something about you" };
  if (IMPERATIVE_START.test(text) && (!options.requireStanding || STANDING.test(said) || STANDING.test(options.saidIn ?? ""))) {
    // "from now on" says it is standing; the wish itself is the rest.
    const wish = text.replace(/,?\s*\b(from now on|going forward|in (the )?future)\b,?\s*/gi, " ").replace(/\s+/g, " ").trim();
    return { type: "instruction", certainty, text: wish.replace(/^./, (first) => first.toUpperCase()), why: "says how BrowserHarness should work" };
  }
  return { type: "unknown", certainty, text, why: "not about you, your choices or how to work" };
}
