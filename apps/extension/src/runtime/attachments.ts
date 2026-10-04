export const ATTACHMENTS_KEY = "browserharness.attachments.v1";
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface AttachmentRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  data_b64: string;
  created_at: number;
}

export type AttachmentMeta = Omit<AttachmentRecord, "data_b64">;

export function toMeta(record: AttachmentRecord): AttachmentMeta {
  const { data_b64: _data, ...meta } = record;
  void _data;
  return meta;
}

function safeName(name: string): string {
  return (
    name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 120) ||
    "attachment"
  );
}

export function createAttachmentRecord(
  input: { name: string; mime?: string; size: number; data_b64: string },
  existingCount: number,
  id: string = crypto.randomUUID(),
  now = Date.now()
): AttachmentRecord {
  if (existingCount >= MAX_ATTACHMENTS) {
    throw new Error(
      `ATTACHMENT_LIMIT: at most ${MAX_ATTACHMENTS} attachments`
    );
  }
  if (input.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `ATTACHMENT_TOO_LARGE: limit is ${MAX_ATTACHMENT_BYTES} bytes`
    );
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data_b64)) {
    throw new Error("ATTACHMENT_INVALID: data must be base64");
  }
  return {
    id,
    name: safeName(input.name),
    mime: input.mime || "application/octet-stream",
    size: input.size,
    data_b64: input.data_b64,
    created_at: now
  };
}

/** Tells the planner which attachments exist; contents are never put in the prompt. */
export function describeAttachmentsForPrompt(
  attachments: AttachmentMeta[]
): string {
  if (!attachments.length) return "";
  const lines = attachments.map(
    (item) =>
      `- id=${item.id} name="${item.name}" type=${item.mime} size=${item.size}`
  );
  return `\n\nUSER ATTACHMENTS (use the upload tool with {"element_id":"<file input ref>","attachment_ids":["<id>"]}; never invent ids):\n${lines.join("\n")}`;
}

export async function listAttachments(): Promise<AttachmentRecord[]> {
  const stored = await chrome.storage.local.get(ATTACHMENTS_KEY);
  const value = stored[ATTACHMENTS_KEY];
  return Array.isArray(value) ? (value as AttachmentRecord[]) : [];
}

export async function saveAttachment(
  input: { name: string; mime?: string; size: number; data_b64: string }
): Promise<AttachmentRecord> {
  const all = await listAttachments();
  const record = createAttachmentRecord(input, all.length);
  await chrome.storage.local.set({
    [ATTACHMENTS_KEY]: [...all, record]
  });
  return record;
}

export async function deleteAttachment(id: string): Promise<void> {
  const all = await listAttachments();
  await chrome.storage.local.set({
    [ATTACHMENTS_KEY]: all.filter((item) => item.id !== id)
  });
}

export async function clearAttachments(): Promise<void> {
  await chrome.storage.local.remove(ATTACHMENTS_KEY);
}

export async function getAttachmentsByIds(
  ids: string[]
): Promise<AttachmentRecord[]> {
  const all = await listAttachments();
  return ids.map((id) => {
    const found = all.find((item) => item.id === id);
    if (!found) throw new Error(`ATTACHMENT_NOT_FOUND: ${id}`);
    return found;
  });
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
