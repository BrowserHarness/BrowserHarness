export type SiteAdapterId = "google-docs" | "generic-web";

export function adapterForUrl(url: string): SiteAdapterId {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "docs.google.com"
      ? "google-docs"
      : "generic-web";
  } catch {
    return "generic-web";
  }
}
