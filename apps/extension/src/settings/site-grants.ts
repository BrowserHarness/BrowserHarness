export const SITE_GRANTS_KEY = "browserharness.siteApprovalGrants.v1";
const MAX_GRANTS = 200;

export interface SiteGrant {
  host: string;
  granted_at: string;
}

export function normalizeGrantHost(value: string): string {
  const raw = value.trim().toLowerCase();
  try {
    const host = raw.includes("://") ? new URL(raw).hostname : raw;
    return host.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** A grant covers its host and its subdomains. Chrome-internal and empty hosts are never grantable. */
export function isGrantableHost(host: string): boolean {
  return (
    Boolean(host) &&
    /^[a-z0-9.-]+$/.test(host) &&
    (host.includes(".") || host === "localhost")
  );
}

export function isHostGranted(
  grants: SiteGrant[],
  host: string
): boolean {
  const normalized = normalizeGrantHost(host);
  if (!isGrantableHost(normalized)) return false;
  return grants.some(
    (grant) =>
      normalized === grant.host ||
      normalized.endsWith(`.${grant.host}`)
  );
}

export function addGrant(
  grants: SiteGrant[],
  host: string,
  now = new Date().toISOString()
): SiteGrant[] {
  const normalized = normalizeGrantHost(host);
  if (!isGrantableHost(normalized)) return grants;
  if (grants.some((grant) => grant.host === normalized)) return grants;
  return [...grants, { host: normalized, granted_at: now }].slice(
    -MAX_GRANTS
  );
}

export function removeGrant(
  grants: SiteGrant[],
  host: string
): SiteGrant[] {
  const normalized = normalizeGrantHost(host);
  return grants.filter((grant) => grant.host !== normalized);
}

export async function loadSiteGrants(): Promise<SiteGrant[]> {
  const stored = await chrome.storage.local.get(SITE_GRANTS_KEY);
  const value = stored[SITE_GRANTS_KEY];
  return Array.isArray(value)
    ? (value as SiteGrant[]).filter(
        (item) => item && typeof item.host === "string"
      )
    : [];
}

export async function saveSiteGrants(
  grants: SiteGrant[]
): Promise<void> {
  await chrome.storage.local.set({ [SITE_GRANTS_KEY]: grants });
}
