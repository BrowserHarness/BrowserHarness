import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  codeChallengeFor,
  connectWithOpenRouter,
  createCodeVerifier,
  exchangeCodeForKey,
  extractAuthorizationCode
} from "./openrouter-oauth";
import { detectLocalModels } from "../ui/SimpleConnect";
import { hasCredentials } from "./provider-store";

describe("OpenRouter OAuth PKCE", () => {
  it("computes the RFC 7636 S256 challenge", async () => {
    expect(
      await codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes long url-safe random verifiers", () => {
    const a = createCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(a).not.toBe(createCodeVerifier());
  });

  it("builds the authorization url", () => {
    const url = new URL(
      buildAuthorizationUrl({ callbackUrl: "https://abc.chromiumapp.org/", codeChallenge: "CH" })
    );
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("https://abc.chromiumapp.org/");
    expect(url.searchParams.get("code_challenge")).toBe("CH");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("extracts the code or explains the failure", () => {
    expect(extractAuthorizationCode("https://abc.chromiumapp.org/?code=XYZ")).toBe("XYZ");
    expect(() => extractAuthorizationCode("https://abc.chromiumapp.org/?error=access_denied")).toThrow("access_denied");
    expect(() => extractAuthorizationCode("https://abc.chromiumapp.org/")).toThrow("did not return");
  });

  it("exchanges the code for a key and rejects bad answers", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ key: " sk-or-123 " }), { status: 200 }));
    expect(await exchangeCodeForKey("C", "V", ok as unknown as typeof fetch)).toBe("sk-or-123");
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(JSON.parse(String(init.body))).toEqual({ code: "C", code_verifier: "V", code_challenge_method: "S256" });

    const bad = async () => new Response("no", { status: 400 });
    await expect(exchangeCodeForKey("C", "V", bad as unknown as typeof fetch)).rejects.toThrow("400");
    const empty = async () => new Response("{}", { status: 200 });
    await expect(exchangeCodeForKey("C", "V", empty as unknown as typeof fetch)).rejects.toThrow("did not return a key");
  });

  it("runs the whole sign-in with the verifier matching the challenge", async () => {
    let challenge = "";
    let sentVerifier = "";
    const key = await connectWithOpenRouter({
      redirectUrl: "https://abc.chromiumapp.org/",
      launchWebAuthFlow: async ({ url, interactive }) => {
        expect(interactive).toBe(true);
        challenge = new URL(url).searchParams.get("code_challenge") || "";
        return "https://abc.chromiumapp.org/?code=THECODE";
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sentVerifier = body.code_verifier;
        expect(body.code).toBe("THECODE");
        return new Response(JSON.stringify({ key: "sk-or-final" }), { status: 200 });
      }) as unknown as typeof fetch
    });
    expect(key).toBe("sk-or-final");
    expect(await codeChallengeFor(sentVerifier)).toBe(challenge);
  });

  it("reports a cancelled sign-in plainly", async () => {
    await expect(
      connectWithOpenRouter({
        redirectUrl: "https://abc.chromiumapp.org/",
        launchWebAuthFlow: async () => {
          throw new Error("The user did not approve access.");
        }
      })
    ).rejects.toThrow("Sign-in was cancelled.");
    await expect(
      connectWithOpenRouter({
        redirectUrl: "https://abc.chromiumapp.org/",
        launchWebAuthFlow: async () => undefined
      })
    ).rejects.toThrow("Sign-in was cancelled.");
  });
});

describe("simple connect helpers", () => {
  it("treats an OpenRouter connection as having credentials", () => {
    expect(hasCredentials({ provider: "openrouter", apiKey: "sk-or" })).toBe(true);
    expect(hasCredentials({ provider: "openrouter", apiKey: "" })).toBe(false);
  });

  it("detects whichever local servers are running", async () => {
    const discover = vi.fn(async (config: { provider: string }) => {
      if (config.provider === "ollama") throw new Error("connection refused");
      return [
        { id: "text-embedding-nomic", capabilities: { chat: false, agent: false } },
        { id: "qwen2.5-7b-instruct", capabilities: { chat: true, agent: true } }
      ];
    });
    const found = await detectLocalModels(discover as never);
    expect(found).toEqual([
      { provider: "lm-studio", baseUrl: "http://localhost:1234/v1", model: "qwen2.5-7b-instruct" }
    ]);
  });
});
