import type { BrowserUserActionOutcome } from "./browser-engine";

export interface UserHandoffPrompt {
  (reason: string): Promise<"continue" | "cancelled">;
}

export interface WaitForUserActionOptions {
  tab_id: number;
  starting_url: string;
  reason: string;
  prompt: UserHandoffPrompt;
  signal?: AbortSignal;
  grace_ms?: number;
}

export async function waitForUserAction(
  options: WaitForUserActionOptions
): Promise<BrowserUserActionOutcome> {
  const graceMs = Math.min(
    Math.max(Math.round(Number(options.grace_ms ?? 10_000)), 0),
    60_000
  );

  return new Promise<BrowserUserActionOutcome>((resolve, reject) => {
    let settled = false;
    let promptStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (outcome: BrowserUserActionOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const navigationComplete = (
      tabId: number,
      tab: chrome.tabs.Tab
    ) => {
      if (
        tabId === options.tab_id &&
        tab.status === "complete" &&
        typeof tab.url === "string" &&
        tab.url !== options.starting_url
      ) {
        finish({
          status: "continue",
          source: "navigation"
        });
      }
    };

    function onUpdated(
      tabId: number,
      _changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) {
      navigationComplete(tabId, tab);
    }

    function onRemoved(tabId: number) {
      if (tabId === options.tab_id) {
        finish({
          status: "cancelled",
          source: "user"
        });
      }
    }

    function onAbort() {
      fail(new DOMException("Manual handoff aborted", "AbortError"));
    }

    const startPrompt = () => {
      if (settled || promptStarted) return;
      promptStarted = true;

      void options
        .prompt(options.reason)
        .then((status) => {
          finish({
            status,
            source: "user"
          });
        })
        .catch((error) => {
          fail(
            error instanceof Error
              ? error
              : new Error(String(error))
          );
        });
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    options.signal?.addEventListener("abort", onAbort, {
      once: true
    });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    void chrome.tabs
      .get(options.tab_id)
      .then((tab) => {
        navigationComplete(options.tab_id, tab);
      })
      .catch(() => undefined);

    timer = setTimeout(startPrompt, graceMs);
  });
}
