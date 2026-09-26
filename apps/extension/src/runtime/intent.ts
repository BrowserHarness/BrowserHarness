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
  /https?:\/\//i
];

export type TaskIntent = "chat" | "browser";

export function classifyTaskIntent(task: string): TaskIntent {
  const normalized = task.trim();
  if (!normalized) return "chat";

  return BROWSER_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized))
    ? "browser"
    : "chat";
}
