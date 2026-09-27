import {
  appendWatchEvent,
  getWatchRecording,
  markWatchTabClosed,
  trackWatchTab
} from "./watch-recording";

export interface WatchBrowserEventDeps {
  armWatchTab: (tabId: number) => Promise<unknown>;
}

export function createWatchBrowserEventHandlers(
  deps: WatchBrowserEventDeps
) {
  return {
    onCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) {
      if (details.frameId !== 0) return;

      void (async () => {
        const session = await getWatchRecording();
        if (!session || !session.tab_ids.includes(details.tabId)) {
          return;
        }

        await appendWatchEvent({
          type: "navigation",
          tab_id: details.tabId,
          url: details.url,
          transition_type: details.transitionType,
          transition_qualifiers: details.transitionQualifiers
        });
      })();
    },

    onCompleted(details: chrome.webNavigation.WebNavigationFramedCallbackDetails) {
      if (details.frameId !== 0) return;

      void (async () => {
        const session = await getWatchRecording();
        if (!session || !session.tab_ids.includes(details.tabId)) {
          return;
        }

        await deps.armWatchTab(details.tabId).catch(() => undefined);
      })();
    },

    onCreated(tab: chrome.tabs.Tab) {
      if (typeof tab.id !== "number") return;

      void (async () => {
        const session = await getWatchRecording();
        if (!session) return;

        const belongs =
          typeof tab.openerTabId === "number" &&
          session.tab_ids.includes(tab.openerTabId);

        if (!belongs) return;

        await trackWatchTab(tab.id!);
        await appendWatchEvent({
          type: "tab_opened",
          tab_id: tab.id!,
          opener_tab_id: tab.openerTabId,
          url: tab.url,
          title: tab.title
        });
      })();
    },

    onActivated(activeInfo: chrome.tabs.TabActiveInfo) {
      void (async () => {
        const session = await getWatchRecording();
        if (!session) return;

        const alreadyTracked = session.tab_ids.includes(
          activeInfo.tabId
        );
        if (!alreadyTracked) {
          await trackWatchTab(activeInfo.tabId);
        }

        const tab = await chrome.tabs
          .get(activeInfo.tabId)
          .catch(() => null);

        await appendWatchEvent({
          type: "tab_activated",
          tab_id: activeInfo.tabId,
          window_id: activeInfo.windowId,
          url: tab?.url,
          title: tab?.title
        });

        if (!alreadyTracked) {
          await deps
            .armWatchTab(activeInfo.tabId)
            .catch(() => undefined);
        }
      })();
    },

    onRemoved(tabId: number) {
      void (async () => {
        const session = await getWatchRecording();
        if (!session || !session.tab_ids.includes(tabId)) {
          return;
        }

        await appendWatchEvent({
          type: "tab_closed",
          tab_id: tabId
        });
        await markWatchTabClosed(tabId);
      })();
    }
  };
}
