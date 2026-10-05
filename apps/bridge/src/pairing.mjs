import crypto from "node:crypto";

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PENDING = 3;
const MAX_WRONG_CODES = 5;

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

/** The Chrome extension id in an Origin header, or "" when it is not one. */
export function extensionIdFromOrigin(origin) {
  const match = EXTENSION_ORIGIN.exec(String(origin || ""));
  return match ? match[1] : "";
}

function sixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Pairing without copying the token: the extension asks to pair and shows a
 * six-digit code; the person confirms the same code in the terminal, and only
 * then does the extension receive the Bridge token.
 */
export function createPairingManager({
  token,
  ttlMs = PAIRING_TTL_MS,
  now = () => Date.now(),
  makeCode = sixDigitCode
} = {}) {
  if (!token) throw new Error("Pairing needs the Bridge token");
  const requests = new Map();
  let wrongCodes = 0;

  function prune() {
    const time = now();
    for (const [id, request] of requests) {
      if (request.expires_at <= time) requests.delete(id);
    }
  }

  return {
    request({ extensionId }) {
      prune();
      const pending = [...requests.values()].filter(
        (request) => request.state === "pending"
      );
      while (pending.length >= MAX_PENDING) {
        requests.delete(pending.shift().request_id);
      }
      const request = {
        request_id: crypto.randomUUID(),
        code: makeCode(),
        extension_id: String(extensionId || ""),
        created_at: now(),
        expires_at: now() + ttlMs,
        state: "pending"
      };
      requests.set(request.request_id, request);
      return {
        request_id: request.request_id,
        code: request.code,
        expires_at: request.expires_at
      };
    },

    pending() {
      prune();
      return [...requests.values()]
        .filter((request) => request.state === "pending")
        .map(({ request_id, code, extension_id, created_at, expires_at }) => ({
          request_id,
          code,
          extension_id,
          created_at,
          expires_at
        }));
    },

    /** Approve the pending request showing `code`. */
    approve(code) {
      prune();
      const wanted = String(code || "").replace(/\D/g, "");
      const match = [...requests.values()].find(
        (request) => request.state === "pending" && request.code === wanted
      );
      if (!match) {
        wrongCodes += 1;
        if (wrongCodes >= MAX_WRONG_CODES) {
          requests.clear();
          wrongCodes = 0;
        }
        return null;
      }
      wrongCodes = 0;
      match.state = "approved";
      return { request_id: match.request_id, extension_id: match.extension_id };
    },

    deny(requestId) {
      const request = requests.get(requestId);
      if (!request || request.state !== "pending") return false;
      request.state = "denied";
      return true;
    },

    /**
     * What the extension sees while it waits. The token is handed out once,
     * and only to the extension that made the request.
     */
    poll(requestId, extensionId) {
      prune();
      const request = requests.get(requestId);
      if (!request || request.extension_id !== extensionId) {
        return { state: "expired" };
      }
      if (request.state === "approved") {
        requests.delete(requestId);
        return { state: "approved", token };
      }
      if (request.state === "denied") {
        requests.delete(requestId);
        return { state: "denied" };
      }
      return { state: "pending", expires_at: request.expires_at };
    }
  };
}
