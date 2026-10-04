import { cdpCommand } from "./cdp-manager";
import { backendNodeForRef } from "./cdp-semantic";

export async function uploadFiles(
  tabId: number,
  ref: string,
  files: string[]
): Promise<{ files: number }> {
  if (!files.length) {
    throw new Error("At least one file path is required");
  }

  const backendNodeId = backendNodeForRef(tabId, ref);
  await cdpCommand(tabId, "DOM.setFileInputFiles", {
    files,
    backendNodeId
  });

  return { files: files.length };
}

/**
 * Sets file input contents from stored attachments (no local path needed): builds File objects
 * from base64 in the page and fires the input/change events a real selection would.
 */
export async function uploadAttachments(
  tabId: number,
  ref: string,
  records: Array<{ name: string; mime: string; data_b64: string }>
): Promise<{ files: number }> {
  if (!records.length) {
    throw new Error("At least one attachment is required");
  }
  const backendNodeId = backendNodeForRef(tabId, ref);
  const resolved = await cdpCommand<{
    object?: { objectId?: string };
  }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("Could not resolve the file input");

  const response = await cdpCommand<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    arguments: [{ value: records }],
    functionDeclaration: `function (records) {
      if (!(this instanceof HTMLInputElement) || this.type !== "file") {
        throw new Error("Target is not a file input");
      }
      const transfer = new DataTransfer();
      for (const record of records) {
        const bytes = Uint8Array.from(atob(record.data_b64), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], record.name, { type: record.mime }));
      }
      this.files = transfer.files;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return this.files.length;
    }`
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "Attachment upload failed"
    );
  }
  return { files: Number(response.result?.value ?? records.length) };
}

function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "browsercrew-page.pdf";
}

export async function savePageAsPdf(
  tabId: number,
  options: {
    filename?: string;
    landscape?: boolean;
    print_background?: boolean;
    scale?: number;
    save_as?: boolean;
  } = {}
): Promise<{
  download_id: number;
  filename: string;
  bytes: number;
}> {
  const result = await cdpCommand<{
    data?: string;
  }>(tabId, "Page.printToPDF", {
    landscape: Boolean(options.landscape),
    printBackground: options.print_background !== false,
    scale: Math.min(
      Math.max(Number(options.scale ?? 1), 0.1),
      2
    ),
    preferCSSPageSize: true
  });

  if (!result.data) {
    throw new Error("Chrome returned no PDF data");
  }

  const filename = safeFilename(
    options.filename || "browsercrew-page.pdf"
  );
  const url = `data:application/pdf;base64,${result.data}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: options.save_as === true
  });

  return {
    download_id: downloadId,
    filename,
    bytes: Math.floor((result.data.length * 3) / 4)
  };
}
