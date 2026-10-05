/**
 * Models often send "amazon.com" or "www.google.com/search?q=x". Chrome
 * resolves those relative to the extension and shows its 404 page, so add
 * https:// when no scheme is given.
 */
export function normalizeNavigableUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^:/]+:\d+(\/|$)/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  const host = trimmed.split(/[/?#]/)[0];
  const local = /^(localhost|127\.|\[::1\])/i.test(host);
  return `${local ? "http" : "https"}://${trimmed}`;
}
