import type {
  ExtensionRequest,
  PageObservation,
  ToolName,
  ToolResult
} from "../runtime/protocol";
import {
  startBridgeClient,
  type BridgeCommand
} from "./bridge-client";
import { originPatternForUrl } from "../settings/browser-access";
import { readPage } from "./read-page";
import {
  screenshotVisibilityError,
  shouldActivateNewTaskTab
} from "./tab-policy";
import {
  waitForTabUsable,
  type NavigationReadyResult
} from "./navigation";
import {
  borrowTab,
  closeTaskSession,
  ensureTaskSession,
  getTaskSession,
  ownTab,
  removeSessionTab,
  selectSessionTab,
  setSessionGroup,
  type TaskSession
} from "./task-sessions";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function requestSession(
  sessionId?: string,
  sessionTitle?: string
): Promise<TaskSession | null> {
  if (!sessionId) return null;
  return ensureTaskSession(
    sessionId,
    sessionTitle?.trim() || "BrowserCrew task"
  );
}

async function targetTab(
  input: Record<string, unknown> = {},
  session: TaskSession | null = null
): Promise<{ tab: chrome.tabs.Tab; session: TaskSession | null }> {
  const requested = input.tab_id;

  if (typeof requested === "number") {
    if (session) {
      session = await selectSessionTab(session, requested);
    }
    const tab = await chrome.tabs.get(requested);
    if (!tab?.id) throw new Error("Tab not found");
    return { tab, session };
  }

  if (session?.current_tab_id) {
    const tab = await chrome.tabs
      .get(session.current_tab_id)
      .catch(() => null);
    if (tab?.id) return { tab, session };
    session = await removeSessionTab(
      session,
      session.current_tab_id
    );
  }

  const tab = await activeTab();
  if (session && tab.id) {
    session = await borrowTab(session, tab.id);
  }
  return { tab, session };
}

async function groupOwnedTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  if (typeof session.group_id === "number") {
    try {
      await chrome.tabs.group({
        groupId: session.group_id,
        tabIds: [tabId]
      });
      return session;
    } catch {
      // Group may have been closed by the user; create a fresh one.
    }
  }

  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, {
    title: session.title.slice(0, 80),
    color: "blue",
    collapsed: false
  });
  return setSessionGroup(session, groupId);
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

async function sendToTab(
  tabId: number,
  payload: unknown
): Promise<ToolResult> {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isInjectableUrl(tab.url)) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_PAGE",
          message:
            "BrowserCrew cannot control Chrome internal pages, the Chrome Web Store, or other protected browser pages."
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
      const pattern = tab.url ? originPatternForUrl(tab.url) : null;
      const hasOriginPermission = pattern
        ? await chrome.permissions.contains({ origins: [pattern] })
        : false;

      if (!hasOriginPermission) {
        return {
          ok: false,
          error: {
            code: "PERMISSION_REQUIRED",
            message:
              "BrowserCrew needs website access for this tab. Grant all-sites access in Settings for cross-site and multi-tab automation.",
            details:
              error instanceof Error
                ? error.message
                : String(error)
          }
        };
      }

      return {
        ok: false,
        error: {
          code: "CONTENT_SCRIPT_UNAVAILABLE",
          message:
            "BrowserCrew could not attach to this page even though site access is granted. Reload this tab once and try again.",
          details:
            error instanceof Error
              ? error.message
              : String(error)
        }
      };
    }
  }
}

async function runTool(
  tool: string,
  input: Record<string, unknown> = {},
  sessionId?: string,
  sessionTitle?: string
): Promise<ToolResult> {
  let session = await requestSession(sessionId, sessionTitle);

  if (tool === "wait") {
    const milliseconds = Math.min(
      Math.max(Number(input.milliseconds ?? 500), 0),
      10_000
    );
    await new Promise((resolve) =>
      setTimeout(resolve, milliseconds)
    );
    return { ok: true, data: { milliseconds } };
  }

  if (tool === "open_tab") {
    const tab = await chrome.tabs.create({
      url: typeof input.url === "string" ? input.url : undefined,
      active: shouldActivateNewTaskTab(input)
    });
    if (!tab?.id) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "Chrome did not return the created tab"
        }
      };
    }

    if (session) {
      session = await ownTab(session, tab.id);
      session = await groupOwnedTab(session, tab.id);
    }

    let ready: NavigationReadyResult = {
      tab_id: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status
    };
    if (typeof input.url === "string") {
      try {
        ready = await waitForTabUsable(tab.id);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "NAVIGATION_TIMEOUT",
            message:
              error instanceof Error
                ? error.message
                : "New tab did not become usable"
          }
        };
      }
    }

    return {
      ok: true,
      data: {
        ...ready,
        session_id: session?.id,
        owned: Boolean(session)
      }
    };
  }

  if (tool === "list_tabs") {
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message: "list_tabs requires an active BrowserCrew task session"
        }
      };
    }

    const ids = [
      ...new Set([
        ...session.borrowed_tab_ids,
        ...session.owned_tab_ids
      ])
    ];
    const tabs = (
      await Promise.all(
        ids.map((id) => chrome.tabs.get(id).catch(() => null))
      )
    )
      .filter((tab): tab is chrome.tabs.Tab => Boolean(tab?.id))
      .map((tab) => ({
        tab_id: tab.id,
        url: tab.url,
        title: tab.title,
        active: Boolean(tab.active),
        owned: session!.owned_tab_ids.includes(tab.id!),
        borrowed: session!.borrowed_tab_ids.includes(tab.id!),
        group_id: tab.groupId
      }));

    return {
      ok: true,
      data: {
        session_id: session.id,
        title: session.title,
        current_tab_id: session.current_tab_id,
        tabs
      }
    };
  }

  if (tool === "find_tab") {
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message: "find_tab requires an active BrowserCrew task session"
        }
      };
    }

    if (input.active === true) {
      const tab = await activeTab();
      if (!tab.id) {
        return {
          ok: false,
          error: {
            code: "TAB_NOT_FOUND",
            message: "Chrome did not return the active tab"
          }
        };
      }
      session = await borrowTab(session, tab.id);
      return {
        ok: true,
        data: {
          tab_id: tab.id,
          url: tab.url,
          title: tab.title,
          borrowed: true
        }
      };
    }

    if (typeof input.url !== "string") {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "find_tab requires an exact url or active:true"
        }
      };
    }

    let requestedUrl = input.url;
    try {
      requestedUrl = new URL(input.url).href;
    } catch {
      // Keep the caller value for exact comparison/error reporting.
    }

    const ids = [
      ...new Set([
        ...session.borrowed_tab_ids,
        ...session.owned_tab_ids
      ])
    ];
    const candidates = await Promise.all(
      ids.map((id) => chrome.tabs.get(id).catch(() => null))
    );
    const found = candidates.find(
      (tab) => tab?.id && tab.url === requestedUrl
    );

    if (!found?.id) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message:
            "No tab with that exact URL belongs to this BrowserCrew task session"
        }
      };
    }

    session = await selectSessionTab(session, found.id);
    return {
      ok: true,
      data: {
        tab_id: found.id,
        url: found.url,
        title: found.title,
        active: Boolean(found.active),
        borrowed: session.borrowed_tab_ids.includes(found.id)
      }
    };
  }

  if (tool === "switch_tab") {
    if (typeof input.tab_id !== "number") {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "tab_id is required"
        }
      };
    }

    if (session) {
      session = await selectSessionTab(session, input.tab_id);
    }

    const tab = await chrome.tabs.update(input.tab_id, {
      active: true
    });
    if (!tab?.id) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "Tab could not be activated"
        }
      };
    }
    return {
      ok: true,
      data: { tab_id: tab.id, url: tab.url }
    };
  }

  if (tool === "close_tab") {
    if (typeof input.tab_id !== "number") {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_FOUND",
          message: "tab_id is required"
        }
      };
    }

    if (session && !session.owned_tab_ids.includes(input.tab_id)) {
      return {
        ok: false,
        error: {
          code: "TAB_NOT_OWNED",
          message:
            "BrowserCrew will not close a borrowed or unrelated user tab."
        }
      };
    }

    await chrome.tabs.remove(input.tab_id);
    if (session) {
      await removeSessionTab(session, input.tab_id);
    }
    return { ok: true, data: { tab_id: input.tab_id } };
  }

  const resolved = await targetTab(input, session);
  const tab = resolved.tab;
  session = resolved.session;
  const tabId = tab.id!;

  if (tool === "navigate") {
    if (typeof input.url !== "string") {
      return {
        ok: false,
        error: {
          code: "NAVIGATION_FAILED",
          message: "url is required"
        }
      };
    }
    const updated = await chrome.tabs.update(tabId, {
      url: input.url
    });
    if (!updated?.id) {
      return {
        ok: false,
        error: {
          code: "NAVIGATION_FAILED",
          message: "Chrome did not return the navigated tab"
        }
      };
    }
    try {
      const ready = await waitForTabUsable(updated.id);
      return {
        ok: true,
        data: {
          ...ready,
          requested_url: input.url,
          session_id: session?.id
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "NAVIGATION_TIMEOUT",
          message:
            error instanceof Error
              ? error.message
              : "Page did not become usable after navigation"
        }
      };
    }
  }

  if (tool === "read_page") {
    try {
      return {
        ok: true,
        data: await readPage(tabId, input)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "READ_PAGE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "BrowserCrew could not read this page"
        }
      };
    }
  }

  if (tool === "screenshot") {
    const visibilityError = screenshotVisibilityError(tab);
    if (visibilityError) {
      return {
        ok: false,
        error: visibilityError
      };
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(
      tab.windowId,
      { format: "png" }
    );
    return {
      ok: true,
      data: { tab_id: tabId, data_url: dataUrl }
    };
  }

  if (tool === "observe_page") {
    return sendToTab(tabId, {
      type: "OBSERVE_PAGE",
      tab_id: tabId
    });
  }

  if (
    ["click", "type", "press_key", "scroll"].includes(tool)
  ) {
    return sendToTab(tabId, {
      type: "EXECUTE_CONTENT_ACTION",
      action: tool,
      input
    });
  }

  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `Unknown tool: ${tool}`
    }
  };
}

const BRIDGE_TOOL_NAMES = new Set<ToolName>([
  "observe_page",
  "read_page",
  "navigate",
  "click",
  "type",
  "press_key",
  "scroll",
  "wait",
  "open_tab",
  "find_tab",
  "list_tabs",
  "switch_tab",
  "close_tab",
  "screenshot"
]);

async function handleBridgeCommand(
  command: BridgeCommand
): Promise<ToolResult> {
  if (!BRIDGE_TOOL_NAMES.has(command.action as ToolName)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_BRIDGE_ACTION",
        message: `Unsupported BrowserCrew Bridge action: ${command.action}`
      }
    };
  }

  const tool = command.action as ToolName;

  if (
    tool === "click" ||
    (tool === "press_key" &&
      String(command.args.key || "") === "Enter")
  ) {
    const observed = await runTool(
      "observe_page",
      {},
      command.session,
      command.title
    );

    if (!observed.ok || !observed.data) {
      return observed;
    }

    const observation = observed.data as PageObservation;
    const elementId = command.args.element_id;
    const element =
      typeof elementId === "string"
        ? observation.elements.find(
            (candidate) =>
              candidate.element_id === elementId ||
              candidate.semantic_ref === elementId
          )
        : undefined;

    const requiresApproval =
      tool === "click"
        ? element?.requires_approval
        : element?.enter_requires_approval;

    if (requiresApproval) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message:
            element?.approval_reason ||
            "This browser action requires explicit user approval in BrowserCrew."
        }
      };
    }
  }

  return runTool(
    tool,
    command.args,
    command.session,
    command.title
  );
}

startBridgeClient(handleBridgeCommand);

chrome.runtime.onMessage.addListener(
  (
    request: ExtensionRequest,
    _sender,
    sendResponse
  ) => {
    void (async () => {
      try {
        if (request.type === "GET_CURRENT_TAB") {
          const tab = await activeTab();
          sendResponse({
            ok: true,
            data: {
              tab_id: tab.id,
              title: tab.title,
              url: tab.url,
              fav_icon_url: tab.favIconUrl
            }
          });
          return;
        }

        if (request.type === "BROWSER_TOOL") {
          sendResponse(
            await runTool(
              request.tool,
              request.input,
              request.session_id,
              request.session_title
            )
          );
          return;
        }

        if (
          request.type === "WATCH_START" ||
          request.type === "WATCH_STOP" ||
          request.type === "WATCH_REPLAY_STEP"
        ) {
          const resolved = await targetTab(
            typeof request.tab_id === "number"
              ? { tab_id: request.tab_id }
              : {}
          );
          const payload =
            request.type === "WATCH_REPLAY_STEP"
              ? { type: request.type, step: request.step }
              : { type: request.type };
          sendResponse(
            await sendToTab(resolved.tab.id!, payload)
          );
          return;
        }

        sendResponse({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Unknown request"
          }
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message:
              error instanceof Error
                ? error.message
                : "Unknown background error"
          }
        });
      }
    })();
    return true;
  }
);
