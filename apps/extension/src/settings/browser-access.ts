export const ALL_SITE_ORIGINS = ["http://*/*", "https://*/*"];

export async function hasAllSitesAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ALL_SITE_ORIGINS });
}

export async function requestAllSitesAccess(): Promise<boolean> {
  return chrome.permissions.request({ origins: ALL_SITE_ORIGINS });
}

export async function revokeAllSitesAccess(): Promise<boolean> {
  return chrome.permissions.remove({ origins: ALL_SITE_ORIGINS });
}

export function originPatternForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

export async function hasEndpointAccess(url: string): Promise<boolean> {
  const pattern = originPatternForUrl(url);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

export async function ensureEndpointAccess(url: string): Promise<boolean> {
  const pattern = originPatternForUrl(url);
  if (!pattern) return false;

  const already = await chrome.permissions.contains({
    origins: [pattern]
  });
  if (already) return true;

  return chrome.permissions.request({ origins: [pattern] });
}
