const KNOWN_SITES =
  "youtube|google|google flights|duckduckgo|bing|yahoo|amazon|gmail|linkedin|twitter|x\\.com|reddit|wikipedia|github|facebook|instagram|netflix|ebay|flipkart|notion|slack|outlook|whatsapp web";

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

export type TaskIntent = "chat" | "browser";

export function classifyTaskIntent(task: string): TaskIntent {
  const normalized = task.trim();
  if (!normalized) return "chat";

  return BROWSER_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized))
    ? "browser"
    : "chat";
}

/**
 * A chat answer that is really a browser action, like Qwen's
 * "<tool_call> <function=browser_navigate>", means the request needed the
 * browser after all.
 */
export function replyAsksForBrowser(reply: string): boolean {
  return /<tool_call>|<function=[\w.-]+>/i.test(reply);
}
