const KNOWN_SITES =
  "youtube|google|google flights|amazon|gmail|linkedin|twitter|x\\.com|reddit|wikipedia|github|facebook|instagram|netflix|ebay|flipkart|notion|slack|outlook|whatsapp web";

const BROWSER_CONTEXT_PATTERNS: RegExp[] = [
  /\b(this|current)\s+(page|tab|site|website|document|doc)\b/i,
  /\bgoogle\s+docs?\b/i,
  /\b(current|my)\s+cursor\b/i,
  /\b(click|scroll|navigate|browse|submit|select|upload|download)\b/i,
  /\b(fill|complete)\s+(in\s+)?(this\s+)?(form|field|page)\b/i,
  /\b(type|write|insert|paste)\s+.+\b(in|into|at)\b.+\b(field|box|document|doc|cursor|page)\b/i,
  /\b(open|switch|close)\s+(a\s+|the\s+|this\s+)?(tab|page|link|result|website|site)\b/i,
  /\bopen\b.+\b(tab|result|link|page)\b/i,
  /\bsearch\s+(this|the current)\s+(page|site|website)\b/i,
  /\b(find|locate)\s+.+\b(on|in)\s+(this|the current)\s+(page|site|website|tab)\b/i,
  /https?:\/\//i,
  /\b(go|navigate|head)\s+to\b/i,
  /\bvisit\b/i,
  /\bsearch\s+(on|the web|online)\b/i,
  /\b(extract|scrape|export)\b.+\b(table|tables|list|rows|data|prices)\b/i,
  /\b(to|as|into)\s+(a\s+)?(csv|spreadsheet)\b/i,
  /\badd\b.+\bto\s+(the\s+|my\s+)?(cart|basket|bag|wishlist)\b/i,
  /\b(sign|log)\s+me\s+(up|in|out)\b/i,
  /\bsubscribe\s+me\b/i,
  new RegExp(`\\b(on|in|at|from|open|launch|use)\\s+(${KNOWN_SITES})\\b`, "i"),
  /\b[a-z0-9-]+\.(com|org|net|io|ai|dev|app|co|in|edu|gov|uk)\b/i
];

// Doing something on a named site ("find a kettle amazon", "follow 20 accounts
// from @brand's instagram followers") is a browser task wherever the site sits.
const SITE_ACTION = new RegExp(
  `\\b(find|search|look for|buy|order|shop|book|follow|unfollow|like|comment on|reply to|message|check|compare|add|watch|play)\\b[\\s\\S]*\\b(${KNOWN_SITES})\\b|\\b(${KNOWN_SITES})\\b[\\s\\S]*\\b(find|search|look for|buy|order|shop|book|follow|unfollow|like|comment on|reply to|message|check|compare|add|watch|play)\\b`,
  "i"
);
const SHOPPING = /\b(buy|purchase|shop for)\s+(me\s+)?(a|an|the|some|\d+)?\s*\w+|\border\s+(me\s+)?(a|an|some|\d+)\s+\w+/i;
const SOCIAL_HANDLE_ACTION = /\b(follow|unfollow|like|dm|message)\b[\s\S]*@[a-z0-9._]{2,}/i;

// "Go ahead", "proceed", "try again" right after a browser task carry it on.
const FOLLOW_UP = /^(ok(ay)?|yes|yeah|yep|sure|go ahead|proceed|continue|carry on|keep going|do it|try again|again|retry|next|go on|now do|then|and then|also|same for|repeat)\b/i;

export type TaskIntent = "chat" | "browser";

export function classifyTaskIntent(task: string, { continuing = false }: { continuing?: boolean } = {}): TaskIntent {
  const normalized = task.trim();
  if (!normalized) return "chat";
  if (continuing && FOLLOW_UP.test(normalized)) return "browser";

  return [...BROWSER_CONTEXT_PATTERNS, SITE_ACTION, SHOPPING, SOCIAL_HANDLE_ACTION].some((pattern) => pattern.test(normalized))
    ? "browser"
    : "chat";
}
