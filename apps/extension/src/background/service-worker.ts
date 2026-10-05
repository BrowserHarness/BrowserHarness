import type { RecordedWorkflowStep } from "../runtime/workflows";
import type {
  ExtensionRequest,
  PageObservation,
  ToolName,
  ToolResult
} from "../runtime/protocol";
import { getAttachmentsByIds } from "../runtime/attachments";
import {
  QUICK_EXPLAIN_MENU_ID,
  QUICK_EXPLAIN_STORAGE_KEY,
  type PendingExplain
} from "../runtime/quick-explain";
import {
  requestBridgeLlm,
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
  elementForAxRef,
  findAxElements
} from "./cdp-semantic";
import {
  parseTrustedKeySequence,
  trustedClick,
  trustedDrag,
  trustedHover,
  trustedInsertAtFocus,
  trustedKey,
  trustedSendKeys,
  trustedType
} from "./cdp-input";
import {
  savePageAsPdf,
  uploadAttachments,
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
import { selectOptions } from "./cdp-select";
import { evaluatePageExpression } from "./page-evaluate";
import { collectCurrentSiteSkill } from "../runtime/site-skill-collector";
import { verifySiteSkillCandidate } from "../runtime/site-skill-verifier";
import {
  runSiteSkillRecipe,
  selectSiteSkillRecipe,
  SiteSkillRunError
} from "../runtime/site-skill-runner";
import {
  deleteSiteSkillCandidate,
  getSiteSkillCandidate,
  getSiteSkillExecutableRevision,
  getSiteSkillFamily,
  getSiteSkillPromotionGate,
  getSiteSkillRevisionComparison,
  getSiteSkillRevision,
  listSiteSkillCandidateSummaries,
  listSiteSkillRevisionSummaries,
  listSiteSkillExecutionEvidence,
  promoteSiteSkillRevision,
  recordSiteSkillEvaluation,
  recordSiteSkillExecutionEvidence,
  rollbackSiteSkillRevision,
  saveSiteSkillCandidate
} from "../runtime/site-skill-store";
import {
  createRefinedSiteSkillCandidate
} from "../runtime/site-skill-refinement";
import {
  deleteTaskEpisodeMemory,
  getTaskEpisodeMemory,
  listTaskEpisodeMemory
} from "../runtime/task-memory";
import {
  deleteTaskEpisodeVector,
  searchTaskMemoryHybrid
} from "../runtime/semantic-memory";
import {
  searchProceduralMemory
} from "../runtime/procedural-memory";
import {
  clearBrowserWorkingMemory,
  getBrowserWorkingMemory
} from "../runtime/working-memory";
import {
  extensionPageApprovalGranted,
  isRiskyTrustedLabel,
  type ToolExecutionOptions
} from "./approval-grant";
import { runExternalMcpTool } from "./mcp-tools";
import {
  goBackAndWait,
  reloadAndWait,
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
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: QUICK_EXPLAIN_MENU_ID,
      title: "Explain selection with BrowserHarness",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    info.menuItemId !== QUICK_EXPLAIN_MENU_ID ||
    !info.selectionText
  ) {
    return;
  }
  const pending: PendingExplain = {
    text: info.selectionText,
    url: info.pageUrl,
    created_at: Date.now()
  };
  // Open first: sidePanel.open needs the user gesture from this click.
  if (tab?.id !== undefined) {
    void chrome.sidePanel
      .open({ tabId: tab.id })
      .catch(() => undefined);
  }
  void chrome.storage.session.set({
    [QUICK_EXPLAIN_STORAGE_KEY]: pending
  });
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
    sessionTitle?.trim() || "BrowserHarness task"
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

// Same id as content/adapters/google-docs.ts. Not imported: sharing a module
// with the content script would split content.js into chunks it cannot load.
const GOOGLE_DOCS_EDITOR_ID = "bc-google-doc-editor";

/**
 * Google Docs draws text on a canvas and only accepts real keyboard input in
 * a hidden editor frame. Focus that frame, then type through the debugger.
 */
async function googleDocsEditorAction(
  tabId: number,
  tool: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const focused = await sendToTab(tabId, {
    type: "EXECUTE_CONTENT_ACTION",
    action: "focus_editor",
    input: {}
  });
  if (!focused.ok) return focused;
  if (tool === "click" || tool === "trusted_click") {
    return {
      ok: true,
      data: {
        focused: GOOGLE_DOCS_EDITOR_ID,
        next: `The document is ready for text. Write it with type and element_id ${GOOGLE_DOCS_EDITOR_ID}.`
      }
    };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (!text) {
    return {
      ok: false,
      error: { code: "ELEMENT_NOT_FOUND", message: "type needs the text to write" }
    };
  }
  try {
    const typed = await trustedInsertAtFocus(tabId, text);
    return {
      ok: true,
      data: { ...typed, editor: "google-docs", mode: "keyboard" }
    };
  } catch (error) {
    // Debugger unavailable (for example DevTools is open on this tab):
    // fall back to the page-level text events.
    const fallback = await sendToTab(tabId, {
      type: "EXECUTE_CONTENT_ACTION",
      action: "type",
      input: { ...input, replace: false }
    });
    if (fallback.ok) {
      return {
        ...fallback,
        data: {
          ...(fallback.data as Record<string, unknown>),
          warning: `Real keyboard input was unavailable (${error instanceof Error ? error.message : String(error)}); used page text events, which Google Docs may ignore. Check the document.`
        }
      };
    }
    return fallback;
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
            "BrowserHarness cannot control Chrome internal pages, the Chrome Web Store, or other protected browser pages."
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
              "BrowserHarness needs website access for this tab. Grant all-sites access in Settings for cross-site and multi-tab automation.",
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
            "BrowserHarness could not attach to this page even though site access is granted. Reload this tab once and try again.",
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

  if (tool === "mcp") {
    return runExternalMcpTool(input, options);
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
          message: "list_tabs requires an active BrowserHarness task session"
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
          message: "find_tab requires an active BrowserHarness task session"
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
            "No tab with that exact URL belongs to this BrowserHarness task session"
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
            "BrowserHarness will not close a borrowed or unrelated user tab."
        }
      };
    }

    await chrome.tabs.remove(input.tab_id);
    if (session) {
      await removeSessionTab(session, input.tab_id);
    }
    return { ok: true, data: { tab_id: input.tab_id } };
  }

  if (tool === "close_session") {
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message:
            "close_session requires a BrowserHarness task session"
        }
      };
    }

    const sessionId = session.id;
    const closedOwnedTabs = await closeTaskSession(session);
    await clearBrowserWorkingMemory(sessionId).catch(
      () => false
    );
    return {
      ok: true,
      data: {
        session_id: sessionId,
        closed_owned_tabs: closedOwnedTabs,
        borrowed_tabs_preserved: session.borrowed_tab_ids.length
      }
    };
  }

  if (tool === "memory") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "search";

    if (action === "active") {
      const sessionId = session?.id;

      if (!sessionId) {
        return {
          ok: false,
          error: {
            code: "SESSION_REQUIRED",
            message:
              "memory active requires a BrowserHarness task session"
          }
        };
      }

      const memory = await getBrowserWorkingMemory(
        sessionId
      );
      return memory
        ? {
            ok: true,
            data: {
              working_memory: memory
            }
          }
        : {
            ok: false,
            error: {
              code: "WORKING_MEMORY_NOT_FOUND",
              message:
                "No active working memory exists for this task session"
            }
          };
    }

    if (action === "search") {
      if (
        typeof input.query !== "string" ||
        !input.query.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "MEMORY_QUERY_REQUIRED",
            message: "memory search requires query"
          }
        };
      }

      const hits = await searchTaskMemoryHybrid(
        input.query,
        Number(input.limit ?? 10)
      );
      return {
        ok: true,
        data: {
          hits,
          episodes: hits.map((hit) => hit.episode)
        }
      };
    }

    if (action === "procedures") {
      if (
        typeof input.query !== "string" ||
        !input.query.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "MEMORY_QUERY_REQUIRED",
            message: "memory procedures requires query"
          }
        };
      }

      return {
        ok: true,
        data: {
          procedures: await searchProceduralMemory(
            input.query,
            Number(input.limit ?? 8)
          )
        }
      };
    }

    if (action === "list") {
      return {
        ok: true,
        data: {
          episodes: await listTaskEpisodeMemory(
            Number(input.limit ?? 50)
          )
        }
      };
    }

    if (action === "get") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "MEMORY_ID_REQUIRED",
            message: "memory get requires id"
          }
        };
      }

      const episode = await getTaskEpisodeMemory(input.id);
      return episode
        ? { ok: true, data: { episode } }
        : {
            ok: false,
            error: {
              code: "MEMORY_NOT_FOUND",
              message: "Task episode memory was not found"
            }
          };
    }

    if (action === "delete") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "MEMORY_ID_REQUIRED",
            message: "memory delete requires id"
          }
        };
      }

      const deleted = await deleteTaskEpisodeMemory(
        input.id
      );
      if (deleted) {
        await deleteTaskEpisodeVector(input.id).catch(
          () => undefined
        );
      }
      return {
        ok: true,
        data: {
          id: input.id,
          deleted
        }
      };
    }

    return {
      ok: false,
      error: {
        code: "MEMORY_ACTION_INVALID",
        message:
          "memory action must be active, search, procedures, list, get, or delete"
      }
    };
  }

  if (tool === "site_skill") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "create";

    if (action === "list") {
      return {
        ok: true,
        data: {
          candidates: await listSiteSkillCandidateSummaries()
        }
      };
    }

    if (action === "get") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill get requires id"
          }
        };
      }
      const candidate = await getSiteSkillCandidate(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      return candidate
        ? { ok: true, data: { candidate } }
        : {
            ok: false,
            error: {
              code: "SITE_SKILL_NOT_FOUND",
              message: "Site Skill candidate was not found"
            }
          };
    }

    if (action === "history") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill history requires id"
          }
        };
      }

      const revisions = await listSiteSkillRevisionSummaries(
        input.id
      );
      if (!revisions.length) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }

      const family = await getSiteSkillFamily(input.id);
      return {
        ok: true,
        data: {
          id: input.id,
          latest_revision_id: family?.latest_revision_id,
          active_revision_id: family?.active_revision_id,
          revisions,
          evaluations: family?.evaluations || [],
          executions:
            await listSiteSkillExecutionEvidence(input.id),
          lifecycle_events: family?.lifecycle_events || [],
          promotion_gate:
            await getSiteSkillPromotionGate(input.id),
          comparison:
            await getSiteSkillRevisionComparison(input.id)
        }
      };
    }

    if (action === "compare") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill compare requires id"
          }
        };
      }

      try {
        const comparison =
          await getSiteSkillRevisionComparison(
            input.id,
            typeof input.revision_id === "string"
              ? input.revision_id
              : undefined,
            typeof input.baseline_revision_id === "string"
              ? input.baseline_revision_id
              : undefined
          );
        return comparison
          ? {
              ok: true,
              data: {
                id: input.id,
                comparison
              }
            }
          : {
              ok: false,
              error: {
                code: "SITE_SKILL_NOT_FOUND",
                message: "Site Skill candidate was not found"
              }
            };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_COMPARISON_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill comparison failed"
          }
        };
      }
    }

    if (action === "promote") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill promote requires id"
          }
        };
      }
      const family = await getSiteSkillFamily(input.id);
      if (!family) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }
      const revisionId =
        typeof input.revision_id === "string"
          ? input.revision_id
          : family.latest_revision_id;
      const gate = await getSiteSkillPromotionGate(
        input.id,
        revisionId
      );
      if (!gate?.eligible) {
        return {
          ok: false,
          data: {
            promotion_gate: gate,
            comparison:
              await getSiteSkillRevisionComparison(
                input.id,
                revisionId
              )
          },
          error: {
            code: "SITE_SKILL_PROMOTION_EVIDENCE_REQUIRED",
            message:
              gate?.reasons.join("; ") ||
              "Promotion evidence is incomplete"
          }
        };
      }

      try {
        const comparison =
          await getSiteSkillRevisionComparison(
            input.id,
            revisionId
          );
        const event = await promoteSiteSkillRevision(
          input.id,
          revisionId
        );
        return {
          ok: true,
          data: {
            id: input.id,
            active_revision_id: revisionId,
            comparison,
            event
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_PROMOTION_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill promotion failed"
          }
        };
      }
    }

    if (action === "rollback") {
      if (
        typeof input.id !== "string" ||
        !input.id.trim() ||
        typeof input.revision_id !== "string" ||
        !input.revision_id.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_REVISION_REQUIRED",
            message:
              "site_skill rollback requires id and revision_id"
          }
        };
      }

      try {
        const event = await rollbackSiteSkillRevision(
          input.id,
          input.revision_id
        );
        return {
          ok: true,
          data: {
            id: input.id,
            active_revision_id: input.revision_id,
            event
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ROLLBACK_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill rollback failed"
          }
        };
      }
    }

    if (action === "delete") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill delete requires id"
          }
        };
      }
      return {
        ok: true,
        data: {
          id: input.id,
          deleted: await deleteSiteSkillCandidate(input.id)
        }
      };
    }

    if (
      action !== "create" &&
      action !== "verify" &&
      action !== "run" &&
      action !== "refine" &&
      action !== "history" &&
      action !== "compare" &&
      action !== "promote" &&
      action !== "rollback"
    ) {
      return {
        ok: false,
        error: {
          code: "SITE_SKILL_ACTION_INVALID",
          message:
            "site_skill action must be create, verify, run, refine, list, get, history, compare, promote, rollback, or delete"
        }
      };
    }
  }

  const resolved = await targetTab(input, session);
  const tab = resolved.tab;
  session = resolved.session;
  const tabId = tab.id!;

  if (
    input.element_id === GOOGLE_DOCS_EDITOR_ID &&
    ["click", "trusted_click", "type", "trusted_type"].includes(tool)
  ) {
    return googleDocsEditorAction(tabId, tool, input);
  }

  if (tool === "site_skill") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "create";

    if (!tab.url || !isInjectableUrl(tab.url)) {
      return {
        ok: false,
        error: {
          code: "SITE_SKILL_UNSUPPORTED_PAGE",
          message:
            "Site Skill creation requires an http(s) page"
        }
      };
    }

    if (action === "refine") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill refine requires id"
          }
        };
      }

      const baseRevision = await getSiteSkillExecutableRevision(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      if (!baseRevision) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }

      try {
        const fresh = await collectCurrentSiteSkill({
          tab_id: tabId,
          url: tab.url,
          title: tab.title || new URL(tab.url).hostname,
          requested_name: baseRevision.candidate.name,
          include_network: input.include_network !== false
        });
        const proposal = createRefinedSiteSkillCandidate(
          baseRevision.candidate,
          fresh.candidate
        );

        if (!proposal.diff.changed) {
          return {
            ok: true,
            data: {
              id: input.id,
              base_revision_id: baseRevision.revision_id,
              refinement_needed: false,
              diff: proposal.diff,
              message:
                "Fresh site evidence matches the existing Skill contract; no revision was created."
            }
          };
        }

        const verification = verifySiteSkillCandidate(
          proposal.candidate,
          fresh.evidence
        );
        if (verification.status !== "verified") {
          return {
            ok: false,
            data: {
              base_revision_id: baseRevision.revision_id,
              diff: proposal.diff,
              verification
            },
            error: {
              code: "SITE_SKILL_REFINEMENT_VERIFICATION_FAILED",
              message:
                "Fresh refinement candidate did not verify against the evidence that produced it"
            }
          };
        }

        proposal.candidate.verification = verification;
        const revision = await saveSiteSkillCandidate(
          proposal.candidate,
          { reason: "refinement" }
        );
        await recordSiteSkillEvaluation(
          input.id,
          revision.revision_id,
          {
            kind: "structural-verification",
            outcome: "passed",
            detail:
              `Refinement candidate verified against fresh evidence ${fresh.evidence.evidence_id}`
          }
        );

        const family = await getSiteSkillFamily(input.id);
        return {
          ok: true,
          data: {
            id: input.id,
            base_revision_id: baseRevision.revision_id,
            proposed_revision_id: revision.revision_id,
            active_revision_id: family?.active_revision_id,
            refinement_needed: true,
            diff: proposal.diff,
            verification,
            promotion_gate:
              await getSiteSkillPromotionGate(
                input.id,
                revision.revision_id
              )
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_REFINEMENT_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill refinement failed"
          }
        };
      }
    }

    if (action === "run") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill run requires id"
          }
        };
      }

      const revision = await getSiteSkillExecutableRevision(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      if (!revision) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }
      const existing = revision.candidate;

      try {
        const recipe = selectSiteSkillRecipe(
          existing,
          typeof input.recipe_id === "string"
            ? input.recipe_id
            : undefined
        );
        if (recipe.form_index < 0) {
          // API recipe: read-only GET against the page's own origin; no form verification or approval needed.
          const apiParameters =
            input.parameters &&
            typeof input.parameters === "object" &&
            !Array.isArray(input.parameters)
              ? (input.parameters as Record<string, unknown>)
              : {};
          const apiStartedAt = new Date().toISOString();
          const apiEvidenceId =
            existing.provenance.evidence_id;
          try {
            const run = await runSiteSkillRecipe({
              tab_id: tabId,
              candidate: existing,
              recipe_id: recipe.id,
              parameters: apiParameters
            });
            await recordSiteSkillEvaluation(
              input.id,
              revision.revision_id,
              {
                kind: "execution",
                outcome: "passed",
                detail: `API recipe ${recipe.id} returned HTTP ${run.output?.http_status}`
              }
            );
            const execution =
              await recordSiteSkillExecutionEvidence(
                input.id,
                revision.revision_id,
                {
                  recipe_id: recipe.id,
                  started_at: apiStartedAt,
                  outcome: "passed",
                  evidence_id: apiEvidenceId,
                  executed_steps: run.executed_steps,
                  submitted: false,
                  parameter_names: Object.keys(apiParameters).sort()
                }
              );
            return {
              ok: true,
              data: {
                candidate_id: existing.id,
                revision_id: revision.revision_id,
                run,
                execution
              }
            };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Site Skill API recipe failed";
            const code =
              error instanceof SiteSkillRunError && error.code
                ? error.code
                : "SITE_SKILL_RUN_FAILED";
            await recordSiteSkillEvaluation(
              input.id,
              revision.revision_id,
              {
                kind: "execution",
                outcome: "failed",
                detail: message
              }
            ).catch(() => undefined);
            await recordSiteSkillExecutionEvidence(
              input.id,
              revision.revision_id,
              {
                recipe_id: recipe.id,
                started_at: apiStartedAt,
                outcome: "failed",
                evidence_id: apiEvidenceId,
                executed_steps: 0,
                submitted: false,
                parameter_names: Object.keys(apiParameters).sort(),
                error_code: code,
                error_message: message
              }
            ).catch(() => null);
            return {
              ok: false,
              data: {
                candidate_id: existing.id,
                revision_id: revision.revision_id,
                refinement_recommended: true,
                next_action: "site_skill refine"
              },
              error: { code, message }
            };
          }
        }
        const fresh = await collectCurrentSiteSkill({
          tab_id: tabId,
          url: tab.url,
          title: tab.title || new URL(tab.url).hostname,
          requested_name: existing.name,
          include_network: input.include_network !== false
        });
        const verification = verifySiteSkillCandidate(
          existing,
          fresh.evidence
        );

        await recordSiteSkillEvaluation(
          input.id,
          revision.revision_id,
          {
            kind: "structural-verification",
            outcome:
              verification.status === "verified"
                ? "passed"
                : "failed",
            detail:
              verification.status === "verified"
                ? "Fresh site structure matched the revision contract"
                : "Fresh site structure did not match the revision contract"
          }
        );

        if (verification.status !== "verified") {
          return {
            ok: false,
            data: {
              revision_id: revision.revision_id,
              verification,
              evidence_id: fresh.evidence.evidence_id,
              refinement_recommended: true,
              next_action: "site_skill refine"
            },
            error: {
              code: "SITE_SKILL_VERIFICATION_FAILED",
              message:
                "Site Skill revision no longer matches fresh site evidence"
            }
          };
        }

        const submitStep = recipe.steps.find(
          (step) => step.kind === "submit"
        );
        const submitLabel =
          submitStep?.target?.accessible_name || recipe.name;
        const requiresApproval = Boolean(
          submitStep &&
            (submitStep.method.toUpperCase() !== "GET" ||
              isRiskyTrustedLabel(submitLabel))
        );

        if (requiresApproval && !options.approvalGranted) {
          return {
            ok: false,
            data: {
              revision_id: revision.revision_id,
              verification
            },
            error: {
              code: "APPROVAL_REQUIRED",
              message:
                `Run Site Skill “${existing.name}” recipe “${recipe.name}” and submit on ${new URL(tab.url).hostname}?`
            }
          };
        }

        const parameters =
          input.parameters &&
          typeof input.parameters === "object" &&
          !Array.isArray(input.parameters)
            ? (input.parameters as Record<string, unknown>)
            : {};
        const executionStartedAt = new Date().toISOString();
        const parameterNames = Object.keys(parameters).sort();

        try {
          const run = await runSiteSkillRecipe({
            tab_id: tabId,
            candidate: existing,
            recipe_id: recipe.id,
            parameters
          });

          await recordSiteSkillEvaluation(
            input.id,
            revision.revision_id,
            {
              kind: "execution",
              outcome: "passed",
              detail:
                `Recipe ${recipe.id} completed through its verified submit boundary`
            }
          );
          const execution =
            await recordSiteSkillExecutionEvidence(
              input.id,
              revision.revision_id,
              {
                recipe_id: recipe.id,
                started_at: executionStartedAt,
                outcome: "passed",
                evidence_id: fresh.evidence.evidence_id,
                executed_steps: run.executed_steps,
                submitted: run.submitted,
                parameter_names: parameterNames
              }
            );

          return {
            ok: true,
            data: {
              candidate_id: existing.id,
              revision_id: revision.revision_id,
              verification,
              run,
              execution
            }
          };
        } catch (error) {
          const runError =
            error instanceof SiteSkillRunError ? error : null;
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Site Skill execution failed";
          const errorCode =
            runError?.code || "SITE_SKILL_RUN_FAILED";

          await recordSiteSkillEvaluation(
            input.id,
            revision.revision_id,
            {
              kind: "execution",
              outcome: "failed",
              detail: errorMessage
            }
          ).catch(() => undefined);

          const execution =
            await recordSiteSkillExecutionEvidence(
              input.id,
              revision.revision_id,
              {
                recipe_id: recipe.id,
                started_at: executionStartedAt,
                outcome: "failed",
                evidence_id: fresh.evidence.evidence_id,
                executed_steps:
                  runError?.executed_steps || 0,
                submitted: runError?.submitted === true,
                parameter_names: parameterNames,
                error_code: errorCode,
                error_message: errorMessage
              }
            ).catch(() => null);

          return {
            ok: false,
            data: {
              candidate_id: existing.id,
              revision_id: revision.revision_id,
              verification,
              execution,
              refinement_recommended: true,
              next_action: "site_skill refine"
            },
            error: {
              code: "SITE_SKILL_RUN_FAILED",
              message: errorMessage
            }
          };
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_RUN_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill execution failed"
          }
        };
      }
    }

    if (action === "verify") {
      if (typeof input.id !== "string" || !input.id.trim()) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_ID_REQUIRED",
            message: "site_skill verify requires id"
          }
        };
      }

      const revision = await getSiteSkillRevision(
        input.id,
        typeof input.revision_id === "string"
          ? input.revision_id
          : undefined
      );
      if (!revision) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_NOT_FOUND",
            message: "Site Skill candidate was not found"
          }
        };
      }
      const existing = revision.candidate;

      try {
        const fresh = await collectCurrentSiteSkill({
          tab_id: tabId,
          url: tab.url,
          title: tab.title || new URL(tab.url).hostname,
          requested_name: existing.name,
          include_network: input.include_network !== false
        });
        const verification = verifySiteSkillCandidate(
          existing,
          fresh.evidence
        );

        await recordSiteSkillEvaluation(
          input.id,
          revision.revision_id,
          {
            kind: "structural-verification",
            outcome:
              verification.status === "verified"
                ? "passed"
                : "failed",
            detail:
              verification.status === "verified"
                ? "Fresh site structure matched the revision contract"
                : "Fresh site structure did not match the revision contract"
          }
        );

        return {
          ok: verification.status === "verified",
          data: {
            candidate: {
              ...existing,
              verification
            },
            revision_id: revision.revision_id,
            verification
          },
          ...(verification.status === "failed"
            ? {
                error: {
                  code: "SITE_SKILL_VERIFICATION_FAILED",
                  message:
                    "Site Skill revision no longer matches fresh site evidence"
                }
              }
            : {})
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SITE_SKILL_VERIFICATION_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Site Skill verification failed"
          }
        };
      }
    }

    try {
      const created = await collectCurrentSiteSkill({
        tab_id: tabId,
        url: tab.url,
        title: tab.title || new URL(tab.url).hostname,
        requested_name:
          typeof input.name === "string" ? input.name : undefined,
        include_network: input.include_network !== false
      });
      const revision = await saveSiteSkillCandidate(
        created.candidate,
        { reason: "create" }
      );

      return {
        ok: true,
        data: {
          candidate: created.candidate,
          revision_id: revision.revision_id,
          evidence_summary: {
            ax_target_count: created.evidence.ax.target_count,
            form_count: created.evidence.forms.length,
            network_request_count: created.evidence.network.length
          },
          persisted: true
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SITE_SKILL_CREATE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Site Skill creation failed"
        }
      };
    }
  }

  if (tool === "back") {
    try {
      return {
        ok: true,
        data: {
          ...(await goBackAndWait(tabId)),
          session_id: session?.id
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "BACK_NAVIGATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Back navigation failed"
        }
      };
    }
  }

  if (tool === "reload") {
    try {
      return {
        ok: true,
        data: {
          ...(await reloadAndWait(tabId, {
            bypassCache: input.bypass_cache === true
          })),
          session_id: session?.id
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "RELOAD_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Reload failed"
        }
      };
    }
  }

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
              : "BrowserHarness could not read this page"
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

  if (tool === "find") {
    const query =
      typeof input.query === "string" ? input.query.trim() : "";
    const role =
      typeof input.role === "string" ? input.role.trim() : "";

    if (!query && !role) {
      return {
        ok: false,
        error: {
          code: "FIND_QUERY_REQUIRED",
          message: "find requires query, role, or both"
        }
      };
    }

    try {
      const snapshot = await captureAxSnapshot(tabId, 1000);
      const matches = findAxElements(snapshot, {
        query,
        role,
        limit: Number(input.limit ?? 20)
      });
      return {
        ok: true,
        data: {
          tab_id: tabId,
          query,
          role,
          scanned: snapshot.elements.length,
          matches
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "FIND_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Semantic find failed"
        }
      };
    }
  }

  if (tool === "evaluate") {
    if (
      typeof input.expression !== "string" ||
      !input.expression.trim()
    ) {
      return {
        ok: false,
        error: {
          code: "EVALUATE_EXPRESSION_REQUIRED",
          message: "evaluate requires a non-empty expression"
        }
      };
    }

    try {
      const maxChars = Math.min(
        Math.max(Number(input.max_chars ?? 50_000), 1_000),
        100_000
      );
      return {
        ok: true,
        data: await evaluatePageExpression(
          tabId,
          input.expression,
          maxChars
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "EVALUATE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Page evaluation failed"
        }
      };
    }
  }

  if (tool === "select_option") {
    if (typeof input.element_id !== "string") {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "select_option requires element_id"
        }
      };
    }

    const rawValues = Array.isArray(input.values)
      ? input.values
      : typeof input.value === "string"
        ? [input.value]
        : [];

    if (rawValues.some((value) => typeof value !== "string")) {
      return {
        ok: false,
        error: {
          code: "SELECT_OPTION_INPUT_INVALID",
          message: "select_option values must be strings"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await selectOptions(
          tabId,
          input.element_id,
          rawValues as string[]
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SELECT_OPTION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Select option failed"
        }
      };
    }
  }

  if (tool === "hover") {
    if (typeof input.element_id !== "string") {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "hover requires element_id"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedHover(tabId, input.element_id)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "HOVER_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Hover failed"
        }
      };
    }
  }

  if (tool === "drag") {
    if (
      typeof input.source_element_id !== "string" ||
      typeof input.target_element_id !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message:
            "drag requires source_element_id and target_element_id"
        }
      };
    }

    try {
      return {
        ok: true,
        data: await trustedDrag(
          tabId,
          input.source_element_id,
          input.target_element_id,
          Number(input.steps ?? 8)
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "DRAG_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Drag failed"
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

  if (tool === "send_keys") {
    if (typeof input.keys !== "string" || !input.keys.trim()) {
      return {
        ok: false,
        error: {
          code: "SEND_KEYS_INPUT_INVALID",
          message:
            'send_keys requires keys, e.g. "Enter", "Mod+A", "Shift+Tab", or "Enter Escape"'
        }
      };
    }

    const repeat = Number(input.repeat ?? 1);

    try {
      const platformInfo = await chrome.runtime.getPlatformInfo();
      const sequence = parseTrustedKeySequence(
        input.keys,
        platformInfo.os
      );

      if (
        sequence.some((chord) => chord.key.key === "Enter") &&
        !options.approvalGranted
      ) {
        try {
          const snapshot = await captureAxSnapshot(tabId, 300);
          const focused = snapshot.elements.find(
            (element) => element.focused
          );
          if (
            focused &&
            isRiskyTrustedLabel(focused.name)
          ) {
            return {
              ok: false,
              error: {
                code: "APPROVAL_REQUIRED",
                message:
                  `Trusted key sequence containing Enter in “${focused.name || focused.role}” requires explicit approval.`
              }
            };
          }
        } catch {
          // AX evidence is best-effort here; parser/runtime validation
          // still applies and BrowserHarness can re-observe after dispatch.
        }
      }

      return {
        ok: true,
        data: await trustedSendKeys(
          tabId,
          input.keys,
          repeat,
          platformInfo.os
        )
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SEND_KEYS_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Trusted key sequence failed"
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
      typeof input.element_id === "string" &&
      Array.isArray(input.attachment_ids) &&
      input.attachment_ids.length > 0 &&
      input.attachment_ids.every((id) => typeof id === "string")
    ) {
      try {
        const records = await getAttachmentsByIds(
          input.attachment_ids as string[]
        );
        return {
          ok: true,
          data: await uploadAttachments(
            tabId,
            input.element_id,
            records
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
                : "Attachment upload failed"
          }
        };
      }
    }

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
  "find",
  "evaluate",
  "site_skill",
  "memory",
  "mcp",
  "select_option",
  "hover",
  "drag",
  "trusted_click",
  "trusted_type",
  "trusted_key",
  "send_keys",
  "dialog",
  "network",
  "upload",
  "save_pdf",
  "cdp",
  "navigate",
  "back",
  "reload",
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
  "close_session",
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
        message: `Unsupported BrowserHarness Bridge action: ${command.action}`
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
            "This browser action requires explicit user approval in BrowserHarness."
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
        if (request.type === "BRIDGE_LLM") {
          // Content scripts share our id but report the page URL: only extension pages may spend the subscription.
          if (
            sender.id !== chrome.runtime.id ||
            !sender.url?.startsWith(chrome.runtime.getURL(""))
          ) {
            sendResponse({
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: "Subscription requests are only accepted from BrowserHarness pages"
              }
            });
            return;
          }
          const result = await requestBridgeLlm(
            request.action,
            request.action === "status"
              ? { adapter: request.adapter }
              : {
                  adapter: request.adapter,
                  model: request.model,
                  system: request.system,
                  prompt: request.prompt,
                  timeout_ms: request.timeout_ms
                }
          );
          sendResponse(result);
          return;
        }

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
