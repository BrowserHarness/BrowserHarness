import { beforeEach, describe, expect, it, vi } from "vitest";

let onEvent:
  | ((
      source: chrome.debugger.Debuggee,
      method: string,
      params?: object
    ) => void)
  | undefined;
let onDetach:
  | ((source: chrome.debugger.Debuggee) => void)
  | undefined;

const attach = vi.fn();
const detach = vi.fn();
const sendCommand = vi.fn();

beforeEach(() => {
  vi.resetModules();
  onEvent = undefined;
  onDetach = undefined;
  attach.mockReset();
  detach.mockReset();
  sendCommand.mockReset();

  attach.mockResolvedValue(undefined);
  detach.mockResolvedValue(undefined);
  sendCommand.mockResolvedValue({});

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      debugger: {
        attach,
        detach,
        sendCommand,
        onEvent: {
          addListener: vi.fn((listener) => {
            onEvent = listener;
          })
        },
        onDetach: {
          addListener: vi.fn((listener) => {
            onDetach = listener;
          })
        }
      }
    }
  });
});

describe("CDP debugger session manager", () => {
  it("attaches once and enables required protocol domains", async () => {
    const { ensureDebugger } = await import("./cdp-manager");

    await ensureDebugger(5);
    await ensureDebugger(5);

    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith({ tabId: 5 }, "1.3");
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 5 },
      "Page.enable"
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 5 },
      "DOM.enable"
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 5 },
      "Accessibility.enable"
    );
  });

  it("tracks and handles native JavaScript dialogs", async () => {
    const {
      ensureDebugger,
      getJavaScriptDialog,
      handleJavaScriptDialog
    } = await import("./cdp-manager");

    await ensureDebugger(8);

    onEvent?.(
      { tabId: 8 },
      "Page.javascriptDialogOpening",
      {
        type: "confirm",
        message: "Delete item?",
        defaultPrompt: ""
      }
    );

    expect(getJavaScriptDialog(8)).toEqual(
      expect.objectContaining({
        type: "confirm",
        message: "Delete item?"
      })
    );

    await handleJavaScriptDialog(8, false);

    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 8 },
      "Page.handleJavaScriptDialog",
      { accept: false }
    );
    expect(getJavaScriptDialog(8)).toBeNull();
  });

  it("clears local state when Chrome detaches the debugger", async () => {
    const {
      ensureDebugger,
      getJavaScriptDialog
    } = await import("./cdp-manager");

    await ensureDebugger(12);
    onEvent?.(
      { tabId: 12 },
      "Page.javascriptDialogOpening",
      { type: "alert", message: "Hello" }
    );
    expect(getJavaScriptDialog(12)).not.toBeNull();

    onDetach?.({ tabId: 12 });

    expect(getJavaScriptDialog(12)).toBeNull();
  });
});
