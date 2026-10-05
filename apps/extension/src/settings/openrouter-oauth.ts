/**
 * "Connect with OpenRouter": a standard OAuth PKCE sign-in. The user logs in on
 * OpenRouter's own page, approves BrowserHarness, and OpenRouter hands back a
 * user-controlled API key that we store like any other key. No key is ever
 * typed or pasted. OpenRouter serves Claude, GPT, Gemini and many other models
 * on pay-as-you-go billing (this is not a ChatGPT or Claude subscription).
 *
 * Flow per https://openrouter.ai/docs/use-cases/oauth-pkce
 */

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createCodeVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(48)));
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64Url(new Uint8Array(digest));
}

export function buildAuthorizationUrl(params: {
  callbackUrl: string;
  codeChallenge: string;
}): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set("callback_url", params.callbackUrl);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function extractAuthorizationCode(redirectUrl: string): string {
  const parsed = new URL(redirectUrl);
  const code = parsed.searchParams.get("code");
  if (!code) {
    const error = parsed.searchParams.get("error");
    throw new Error(
      error
        ? `OpenRouter sign-in was not completed (${error}).`
        : "OpenRouter did not return a sign-in code."
    );
  }
  return code;
}

export async function exchangeCodeForKey(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(OPENROUTER_KEY_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256"
    })
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter could not finish the connection (${response.status}). Please try again.`
    );
  }
  const json = (await response.json()) as { key?: unknown };
  if (typeof json.key !== "string" || !json.key.trim()) {
    throw new Error("OpenRouter did not return a key. Please try again.");
  }
  return json.key.trim();
}

export type WebAuthFlow = (details: {
  url: string;
  interactive: boolean;
}) => Promise<string | undefined>;

/** Run the whole sign-in and return the new API key. */
export async function connectWithOpenRouter(
  options: {
    launchWebAuthFlow?: WebAuthFlow;
    redirectUrl?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<string> {
  const launch: WebAuthFlow =
    options.launchWebAuthFlow ??
    ((details) => chrome.identity.launchWebAuthFlow(details));
  const callbackUrl = options.redirectUrl ?? chrome.identity.getRedirectURL();

  const verifier = createCodeVerifier();
  const authUrl = buildAuthorizationUrl({
    callbackUrl,
    codeChallenge: await codeChallengeFor(verifier)
  });

  let redirected: string | undefined;
  try {
    redirected = await launch({ url: authUrl, interactive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /closed|cancel|did not approve|user/i.test(message)
        ? "Sign-in was cancelled."
        : `Could not open the OpenRouter sign-in: ${message}`
    );
  }
  if (!redirected) throw new Error("Sign-in was cancelled.");

  return exchangeCodeForKey(
    extractAuthorizationCode(redirected),
    verifier,
    options.fetchImpl
  );
}
