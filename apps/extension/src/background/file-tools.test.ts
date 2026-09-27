import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cdpCommand: vi.fn(),
  backendNodeForRef: vi.fn()
}));

vi.mock("./cdp-manager", () => ({
  cdpCommand: mocks.cdpCommand
}));

vi.mock("./cdp-semantic", () => ({
  backendNodeForRef: mocks.backendNodeForRef
}));

import {
  savePageAsPdf,
  uploadFiles
} from "./file-tools";

const download = vi.fn();

beforeEach(() => {
  mocks.cdpCommand.mockReset();
  mocks.backendNodeForRef.mockReset();
  download.mockReset();

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      downloads: { download }
    }
  });
});

describe("CDP upload and PDF tools", () => {
  it("sets local files on an AX-referenced file input", async () => {
    mocks.backendNodeForRef.mockReturnValue(501);
    mocks.cdpCommand.mockResolvedValue({});

    await expect(
      uploadFiles(4, "@e1", [
        "C:\\files\\one.txt",
        "C:\\files\\two.pdf"
      ])
    ).resolves.toEqual({ files: 2 });

    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      4,
      "DOM.setFileInputFiles",
      {
        files: [
          "C:\\files\\one.txt",
          "C:\\files\\two.pdf"
        ],
        backendNodeId: 501
      }
    );
  });

  it("prints a page to PDF and downloads the result", async () => {
    mocks.cdpCommand.mockResolvedValue({
      data: "JVBERi0xLjQK"
    });
    download.mockResolvedValue(42);

    const result = await savePageAsPdf(5, {
      filename: "report.pdf",
      print_background: true
    });

    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      5,
      "Page.printToPDF",
      expect.objectContaining({
        printBackground: true,
        preferCSSPageSize: true
      })
    );
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "report.pdf",
        saveAs: false
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        download_id: 42,
        filename: "report.pdf"
      })
    );
  });
});
