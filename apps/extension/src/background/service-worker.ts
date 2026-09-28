import type { RecordedWorkflowStep } from "../runtime/workflows";
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
  cdpCommand,
  getJavaScriptDialog,
  handleJavaScriptDialog
} from "./cdp-manager";
import {
  captureAxSnapshot,
  elementForAxRef
} from "./cdp-semantic";
import {
  trustedClick,
  trustedKey,
  trustedType
} from "./cdp-input";
import {
  savePageAsPdf,
  uploadFiles
} from "./file-tools";
import {
  listNetworkRecords,
  networkCaptureActive,
  networkRecordDetail,
  startNetworkCapture,
  stopNetworkCapture
} from "./network-capture";
import { shouldActivateNewTaskTab } from "./tab-policy";
import { captureCdpScreenshot } from "./cdp-screenshot";
import {
  extensionPageApprovalGranted,
  isRiskyTrustedLabel,
  type ToolExecutionOptions
} from "./approval-grant";
import {
  waitForTabUsable,
  type NavigationReadyResult
} from "./navigation";
import {
  appendWatchStep,
  getWatchRecording,
  startWatchRecording,
  stopWatchRecording,
  watchRecordingSummary
} from "./watch-recording";
import { createWatchBrowserEventHandlers } from "./watch-browser-events";
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
  sessionTitle?: string,
  options: ToolExecutionOptions = {}
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

  if (tool === "ax_snapshot") {
    try {
      const maxElements = Math.min(
        Math.max(Number(input.max_elements ?? 300), 25),
        1000
      );
      return {
        ok: true,
        data: await captureAxSnapshot(tabId, maxElements)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "AX_SNAPSHOT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Accessibility snapshot failed"
        }
      };
    }
  }

  if (tool === "trusted_click") {
    if (typeof input.element_id !== "string") {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "trusted_click requires element_id"
        }
      };
    }

    const element = elementForAxRef(tabId, input.element_id);
    const label = element?.name || "";
    const risky = isRiskyTrustedLabel(label);

    if (risky && !options.approvalGranted) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: `Trusted click “${label || input.element_id}” requires explicit approval.`
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedClick(tabId, input.element_id)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRUSTED_CLICK_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted click failed"
        }
      };
    }
  }

  if (tool === "trusted_type") {
    if (
      typeof input.element_id !== "string" ||
      typeof input.text !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message:
            "trusted_type requires element_id and text"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedType(
          tabId,
          input.element_id,
          input.text
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRUSTED_TYPE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted text input failed"
        }
      };
    }
  }

  if (tool === "trusted_key") {
    if (typeof input.key !== "string" || !input.key) {
      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "trusted_key requires key"
        }
      };
    }

    if (input.key === "Enter") {
      try {
        const snapshot = await captureAxSnapshot(tabId, 300);
        const focused = snapshot.elements.find(
          (element) => element.focused
        );
        if (
          focused &&
          isRiskyTrustedLabel(focused.name) &&
          !options.approvalGranted
        ) {
          return {
            ok: false,
            error: {
              code: "APPROVAL_REQUIRED",
              message: `Trusted Enter in “${focused.name || focused.role}” requires explicit approval.`
            }
          };
        }
      } catch {
        // If AX metadata is unavailable, continue; browser-engine approval
        // still applies to ordinary semantic controls.
      }
    }

    try {
      return {
        ok: true,
        data: await trustedKey(tabId, input.key)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRUSTED_KEY_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted key input failed"
        }
      };
    }
  }

  if (tool === "dialog") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "status";

    if (action === "status") {
      return {
        ok: true,
        data: {
          open: Boolean(getJavaScriptDialog(tabId)),
          dialog: getJavaScriptDialog(tabId)
        }
      };
    }

    if (action !== "accept" && action !== "dismiss") {
      return {
        ok: false,
        error: {
          code: "DIALOG_ACTION_INVALID",
          message:
            "dialog action must be status, accept, or dismiss"
        }
      };
    }

    try {
      await handleJavaScriptDialog(
        tabId,
        action === "accept",
        typeof input.prompt_text === "string"
          ? input.prompt_text
          : undefined
      );
      return {
        ok: true,
        data: { action }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "DIALOG_ACTION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Dialog action failed"
        }
      };
    }
  }

  if (tool === "network") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "list";

    try {
      if (action === "start") {
        await startNetworkCapture(
          tabId,
          Number(input.max_entries ?? 500)
        );
        return {
          ok: true,
          data: {
            active: true,
            tab_id: tabId
          }
        };
      }

      if (action === "list") {
        return {
          ok: true,
          data: {
            active: networkCaptureActive(tabId),
            requests: listNetworkRecords(
              tabId,
              Number(input.limit ?? 100)
            )
          }
        };
      }

      if (action === "detail") {
        if (typeof input.request_id !== "string") {
          return {
            ok: false,
            error: {
              code: "NETWORK_REQUEST_ID_REQUIRED",
              message:
                "network detail requires request_id"
            }
          };
        }
        return {
          ok: true,
          data: await networkRecordDetail(
            tabId,
            input.request_id,
            input.include_body !== false
          )
        };
      }

      if (action === "stop") {
        return {
          ok: true,
          data: await stopNetworkCapture(tabId)
        };
      }

      return {
        ok: false,
        error: {
          code: "NETWORK_ACTION_INVALID",
          message:
            "network action must be start, list, detail, or stop"
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "NETWORK_CAPTURE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Network capture failed"
        }
      };
    }
  }

  if (tool === "upload") {
    if (
      typeof input.element_id !== "string" ||
      !Array.isArray(input.files) ||
      input.files.some((file) => typeof file !== "string")
    ) {
      return {
        ok: false,
        error: {
          code: "UPLOAD_INPUT_INVALID",
          message:
            "upload requires element_id and files:string[]"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await uploadFiles(
          tabId,
          input.element_id,
          input.files as string[]
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "UPLOAD_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "File upload failed"
        }
      };
    }
  }

  if (tool === "save_pdf") {
    try {
      return {
        ok: true,
        data: await savePageAsPdf(tabId, {
          filename:
            typeof input.filename === "string"
              ? input.filename
              : undefined,
          landscape: Boolean(input.landscape),
          print_background:
            input.print_background !== false,
          scale:
            typeof input.scale === "number"
              ? input.scale
              : undefined,
          save_as: input.save_as === true
        })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "PDF_EXPORT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "PDF export failed"
        }
      };
    }
  }

  if (tool === "cdp") {
    if (typeof input.method !== "string" || !input.method.trim()) {
      return {
        ok: false,
        error: {
          code: "CDP_METHOD_REQUIRED",
          message: "cdp requires a DevTools protocol method"
        }
      };
    }

    const params =
      input.params &&
      typeof input.params === "object" &&
      !Array.isArray(input.params)
        ? (input.params as Record<string, unknown>)
        : {};

    try {
      return {
        ok: true,
        data: await cdpCommand(
          tabId,
          input.method.trim(),
          params
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "CDP_COMMAND_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "CDP command failed"
        }
      };
    }
  }

  if (tool === "screenshot") {
    try {
      const captured = await captureCdpScreenshot(tabId, {
        ...(typeof input.element_id === "string"
          ? { element_id: input.element_id }
          : {}),
        full_page: input.full_page === true
      });
      return {
        ok: true,
        data: {
          tab_id: tabId,
          data_url: captured.data_url,
          mode: captured.mode
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SCREENSHOT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "CDP screenshot failed"
        }
      };
    }
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
  "ax_snapshot",
  "trusted_click",
  "trusted_type",
  "trusted_key",
  "dialog",
  "network",
  "upload",
  "save_pdf",
  "cdp",
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

async function armWatchTab(tabId: number): Promise<ToolResult> {
  return sendToTab(tabId, { type: "WATCH_ARM" });
}

async function disarmWatchTab(
  tabId: number
): Promise<RecordedWorkflowStep | null> {
  const result = await sendToTab(tabId, {
    type: "WATCH_DISARM"
  });

  if (!result.ok || !result.data) return null;

  const data = result.data as {
    final_step?: RecordedWorkflowStep;
  };
  return data.final_step || null;
}

const watchBrowserEvents = createWatchBrowserEventHandlers({
  armWatchTab
});

chrome.webNavigation.onCommitted.addListener(
  watchBrowserEvents.onCommitted
);
chrome.webNavigation.onCompleted.addListener(
  watchBrowserEvents.onCompleted
);
chrome.tabs.onCreated.addListener(
  watchBrowserEvents.onCreated
);
chrome.tabs.onActivated.addListener(
  watchBrowserEvents.onActivated
);
chrome.tabs.onRemoved.addListener(
  watchBrowserEvents.onRemoved
);

startBridgeClient(handleBridgeCommand);

chrome.runtime.onMessage.addListener(
  (
    request: ExtensionRequest,
    sender,
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
          const approvalGranted =
            extensionPageApprovalGranted(
              request.approval_granted,
              sender,
              chrome.runtime.id,
              chrome.runtime.getURL("")
            );

          sendResponse(
            await runTool(
              request.tool,
              request.input,
              request.session_id,
              request.session_title,
              { approvalGranted }
            )
          );
          return;
        }

        if (request.type === "WATCH_STATUS") {
          const active = await getWatchRecording();
          sendResponse({
            ok: true,
            data: active
              ? {
                  recording: true,
                  recording_id: active.id,
                  started_at: active.started_at,
                  root_tab_id: active.root_tab_id,
                  current_tab_id: active.current_tab_id,
                  tab_count: active.tab_ids.length,
                  step_count: active.steps.length,
                  event_count: active.events.length,
                  boundary_step_id: active.boundary_step_id
                }
              : {
                  recording: false
                }
          });
          return;
        }

        if (request.type === "WATCH_START") {
          const resolved = await targetTab(
            typeof request.tab_id === "number"
              ? { tab_id: request.tab_id }
              : {}
          );

          const session = await startWatchRecording(resolved.tab);
          const armed = await armWatchTab(resolved.tab.id!);

          if (!armed.ok) {
            await stopWatchRecording();
            sendResponse(armed);
            return;
          }

          sendResponse({
            ok: true,
            data: {
              recording: true,
              recording_id: session.id,
              root_tab_id: session.root_tab_id,
              start_url: session.start_url
            }
          });
          return;
        }

        if (request.type === "WATCH_CAPTURE_STEP") {
          const tabId = sender.tab?.id;
          if (typeof tabId !== "number") {
            sendResponse({
              ok: false,
              error: {
                code: "WATCH_TAB_REQUIRED",
                message:
                  "Recorded workflow steps must come from a browser tab"
              }
            });
            return;
          }

          const captured = await appendWatchStep(
            tabId,
            request.step
          );
          sendResponse({
            ok: Boolean(captured.session),
            data: {
              accepted: captured.accepted
            },
            ...(!captured.session
              ? {
                  error: {
                    code: "WATCH_NOT_RECORDING",
                    message:
                      "No active Watch Me recording session"
                  }
                }
              : {})
          });
          return;
        }

        if (request.type === "WATCH_STOP") {
          const active = await getWatchRecording();
          if (!active) {
            sendResponse({
              ok: false,
              error: {
                code: "WATCH_NOT_RECORDING",
                message: "No active Watch Me recording session"
              }
            });
            return;
          }

          for (const tabId of active.tab_ids) {
            const finalStep = await disarmWatchTab(tabId).catch(
              () => null
            );
            if (finalStep) {
              await appendWatchStep(tabId, finalStep);
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 25));

          const completed = await stopWatchRecording();
          if (!completed) {
            sendResponse({
              ok: false,
              error: {
                code: "WATCH_NOT_RECORDING",
                message:
                  "Watch Me recording ended before it could be saved"
              }
            });
            return;
          }

          const currentTab = await chrome.tabs
            .get(completed.current_tab_id)
            .catch(() => null);

          sendResponse({
            ok: true,
            data: {
              recording_active: false,
              recording_id: completed.id,
              started_at: completed.started_at,
              start_url: completed.start_url,
              end_url:
                currentTab?.url ||
                completed.steps.at(-1)?.url ||
                completed.start_url,
              steps: completed.steps,
              events: completed.events,
              boundary_step_id: completed.boundary_step_id,
              recording: watchRecordingSummary(completed)
            }
          });
          return;
        }

        if (request.type === "WATCH_REPLAY_STEP") {
          const resolved = await targetTab(
            typeof request.tab_id === "number"
              ? { tab_id: request.tab_id }
              : {}
          );
          sendResponse(
            await sendToTab(resolved.tab.id!, {
              type: request.type,
              step: request.step
            })
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
