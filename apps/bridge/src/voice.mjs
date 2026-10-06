// Voice notes in chat apps: a voice note from someone you allowed is turned
// into text by the speech-to-text service you chose (any service with an
// OpenAI-style /audio/transcriptions address, on this computer or online),
// and the words run as the task. Nothing picks a service or model for you.

export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

const isLoopback = (hostname) => hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname);

/** The service's base address, refusing plain http to another computer (the voice note and key would travel unencrypted). */
export function voiceServiceUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("Give the speech-to-text service's address, like https://api.example.com/v1");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error("Use an https address (plain http only works for a service on this computer).");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** transcribe({ data, type, name }) resolves to the words in the voice note. */
export function createTranscriber({ url, model, apiKey = "", language = "", fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
  if (!model) throw new Error("Choose the speech-to-text model your service offers: --model <name>");
  const endpoint = `${voiceServiceUrl(url)}/audio/transcriptions`;
  return async ({ data, type = "audio/ogg", name = "voice.ogg" }) => {
    if (!data?.byteLength) throw new Error("the voice note was empty");
    if (data.byteLength > MAX_VOICE_BYTES) throw new Error("it is too long (20 MB at most)");
    const form = new FormData();
    form.append("file", new Blob([data], { type }), name);
    form.append("model", model);
    form.append("response_format", "json");
    if (language) form.append("language", language);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new Error(`the speech-to-text service didn't answer (${error instanceof Error ? error.message : String(error)})`);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`the speech-to-text service said: ${json.error?.message || json.message || response.status}`);
    return String(json.text ?? "").trim();
  };
}

/** Downloads a voice note, refusing anything too large. */
export async function downloadVoice(url, { headers = {}, type = "audio/ogg", name = "voice.ogg", fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`couldn't download it (${response.status})`);
  if (Number(response.headers.get("content-length") || 0) > MAX_VOICE_BYTES) throw new Error("it is too long (20 MB at most)");
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_VOICE_BYTES) throw new Error("it is too long (20 MB at most)");
  return { data, type: response.headers.get("content-type")?.split(";")[0] || type, name };
}

/** One second of silence as a WAV file, to check a service during setup without recording anything. */
export function silentWav(seconds = 1, rate = 16_000) {
  const samples = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return { data: new Uint8Array(buffer), type: "audio/wav", name: "check.wav" };
}
