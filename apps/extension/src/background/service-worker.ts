import type { ExtensionRequest, ToolResult } from "../runtime/protocol";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function targetTab(input: Record<string, unknown> = {}) {
  const requested = input.tab_id;
  if (typeof requested === "number") {
    const tab = await chrome.tabs.get(requested);
    if (!tab?.id) throw new Error("Tab not found");
    return tab;
  }
  return activeTab();
}

function isInjectableUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function sendToTab(tabId: number, payload: unknown): Promise<ToolResult> {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isInjectableUrl(tab.url)) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_PAGE",
          message: "BrowserCrew cannot control Chrome internal pages, the Chrome Web Store, or other protected browser pages."
        }
      };
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["assets/content.js"]
      });
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "CONTENT_SCRIPT_UNAVAILABLE",
          message:
            "BrowserCrew could not attach to this page automatically. Reload this tab once and try again.",
          details: error instanceof Error ? error.message : String(error)
        }
      } as ToolResult;
    }
  }
}

async function runTool(tool: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  if (tool === "wait") {
    const milliseconds = Math.min(Math.max(Number(input.milliseconds ?? 500), 0), 10_000);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { ok: true, data: { milliseconds } };
  }

  if (tool === "open_tab") {
    const tab = await chrome.tabs.create({
      url: typeof input.url === "string" ? input.url : undefined,
      active: input.active !== false
    });
    if (!tab?.id) {
      return { ok: false, error: { code: "TAB_NOT_FOUND", message: "Chrome did not return the created tab" } };
    }
    return { ok: true, data: { tab_id: tab.id, url: tab.url } };
  }

  if (tool === "switch_tab") {
    if (typeof input.tab_id !== "number") {
      return { ok: false, error: { code: "TAB_NOT_FOUND", message: "tab_id is required" } };
    }
    const tab = await chrome.tabs.update(input.tab_id, { active: true });
    if (!tab?.id) {
      return { ok: false, error: { code: "TAB_NOT_FOUND", message: "Tab could not be activated" } };
    }
    return { ok: true, data: { tab_id: tab.id, url: tab.url } };
  }

  if (tool === "close_tab") {
    if (typeof input.tab_id !== "number") {
      return { ok: false, error: { code: "TAB_NOT_FOUND", message: "tab_id is required" } };
    }
    await chrome.tabs.remove(input.tab_id);
    return { ok: true, data: { tab_id: input.tab_id } };
  }

  const tab = await targetTab(input);
  const tabId = tab.id!;

  if (tool === "navigate") {
    if (typeof input.url !== "string") {
      return { ok: false, error: { code: "NAVIGATION_FAILED", message: "url is required" } };
    }
    const updated = await chrome.tabs.update(tabId, { url: input.url });
    if (!updated?.id) {
      return { ok: false, error: { code: "NAVIGATION_FAILED", message: "Chrome did not return the navigated tab" } };
    }
    return { ok: true, data: { tab_id: updated.id, url: input.url } };
  }

  if (tool === "screenshot") {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { ok: true, data: { tab_id: tabId, data_url: dataUrl } };
  }

  if (tool === "observe_page") {
    return sendToTab(tabId, { type: "OBSERVE_PAGE", tab_id: tabId });
  }

  if (["click", "type", "press_key", "scroll"].includes(tool)) {
    return sendToTab(tabId, {
      type: "EXECUTE_CONTENT_ACTION",
      action: tool,
      input
    });
  }

  return { ok: false, error: { code: "INTERNAL_ERROR", message: `Unknown tool: ${tool}` } };
}

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  void (async () => {
    try {
      if (request.type === "GET_CURRENT_TAB") {
        const tab = await activeTab();
        sendResponse({
          ok: true,
          data: { tab_id: tab.id, title: tab.title, url: tab.url, fav_icon_url: tab.favIconUrl }
        });
        return;
      }
      if (request.type === "BROWSER_TOOL") {
        sendResponse(await runTool(request.tool, request.input));
        return;
      }
      if (request.type === "WATCH_START" || request.type === "WATCH_STOP" || request.type === "WATCH_REPLAY_STEP") {
        const tab = await targetTab(typeof request.tab_id === "number" ? { tab_id: request.tab_id } : {});
        const payload =
          request.type === "WATCH_REPLAY_STEP"
            ? { type: request.type, step: request.step }
            : { type: request.type };
        sendResponse(await sendToTab(tab.id!, payload));
        return;
      }
      sendResponse({ ok: false, error: { code: "INTERNAL_ERROR", message: "Unknown request" } });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown background error"
        }
      });
    }
  })();
  return true;
});
