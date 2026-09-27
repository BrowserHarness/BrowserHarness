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
