import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  createAttachmentRecord,
  describeAttachmentsForPrompt,
  toMeta
} from "./attachments";

const input = { name: "cv.pdf", mime: "application/pdf", size: 3, data_b64: "AAEC" };

describe("attachments", () => {
  it("creates a bounded record and strips unsafe name characters", () => {
    const record = createAttachmentRecord({ ...input, name: "../a:b?.pdf" }, 0, "id1", 5);
    expect(record).toMatchObject({ id: "id1", mime: "application/pdf", created_at: 5 });
    expect(record.name).not.toMatch(/[\\/:?]/);
  });

  it("enforces count, size and base64 limits", () => {
    expect(() => createAttachmentRecord(input, MAX_ATTACHMENTS)).toThrow("ATTACHMENT_LIMIT");
    expect(() =>
      createAttachmentRecord({ ...input, size: MAX_ATTACHMENT_BYTES + 1 }, 0)
    ).toThrow("ATTACHMENT_TOO_LARGE");
    expect(() =>
      createAttachmentRecord({ ...input, data_b64: "not base64!" }, 0)
    ).toThrow("ATTACHMENT_INVALID");
  });

  it("describes attachments to the planner without leaking content", () => {
    const record = createAttachmentRecord(input, 0, "id1");
    const text = describeAttachmentsForPrompt([toMeta(record)]);
    expect(text).toContain("id=id1");
    expect(text).not.toContain("AAEC");
    expect(describeAttachmentsForPrompt([])).toBe("");
  });
});
