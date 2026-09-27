export interface JavaScriptDialogState {
  type: string;
  message: string;
  default_prompt?: string;
  url?: string;
}

const attachedTabs = new Set<number>();
const dialogs = new Map<number, JavaScriptDialogState>();

function target(tabId: number): chrome.debugger.Debuggee {
  return { tabId };
}

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attachedTabs.delete(source.tabId);
    dialogs.delete(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;

  if (method === "Page.javascriptDialogOpening") {
    const payload = params as {
      type?: string;
      message?: string;
      defaultPrompt?: string;
      url?: string;
    };
    dialogs.set(source.tabId, {
      type: payload.type || "alert",
      message: payload.message || "",
      default_prompt: payload.defaultPrompt,
      url: payload.url
    });
  }

  if (method === "Page.javascriptDialogClosed") {
    dialogs.delete(source.tabId);
  }
});

export async function ensureDebugger(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;

  await chrome.debugger.attach(target(tabId), "1.3");
  attachedTabs.add(tabId);

  await Promise.all([
    chrome.debugger.sendCommand(target(tabId), "Page.enable"),
    chrome.debugger.sendCommand(target(tabId), "DOM.enable"),
    chrome.debugger.sendCommand(target(tabId), "Accessibility.enable")
  ]);
}

export async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  await chrome.debugger.detach(target(tabId)).catch(() => undefined);
  attachedTabs.delete(tabId);
  dialogs.delete(tabId);
}

export async function cdpCommand<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand(
    target(tabId),
    method,
    params
  ) as Promise<T>;
}

export function getJavaScriptDialog(
  tabId: number
): JavaScriptDialogState | null {
  return dialogs.get(tabId) || null;
}

export async function handleJavaScriptDialog(
  tabId: number,
  accept: boolean,
  promptText?: string
): Promise<void> {
  await cdpCommand(tabId, "Page.handleJavaScriptDialog", {
    accept,
    ...(promptText !== undefined ? { promptText } : {})
  });
  dialogs.delete(tabId);
}
