export interface NavigationReadyResult {
  tab_id: number;
  url?: string;
  title?: string;
  status?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 350;

function usableState(value: unknown): boolean {
  return value === "interactive" || value === "complete";
}

async function documentReady(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.readyState
    });
    return usableState(result?.result);
  } catch {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.status === "complete" && tab.url !== "about:blank";
    } catch {
      return false;
    }
  }
}

export async function waitForTabUsable(
  tabId: number,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<NavigationReadyResult> {
  const initial = await chrome.tabs.get(tabId);
  if (
    initial.status === "complete" &&
    initial.url !== "about:blank" &&
    (await documentReady(tabId))
  ) {
    return {
      tab_id: tabId,
      url: initial.url,
      title: initial.title,
      status: initial.status
    };
  }

  return new Promise<NavigationReadyResult>((resolve, reject) => {
    let settled = false;
    let pollTimer: number | undefined;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      clearTimeout(timeoutTimer);
    };

    const succeed = async () => {
      if (settled) return;
      if (!(await documentReady(tabId))) return;

      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return;
      }

      if (!tab.url || tab.url === "about:blank") return;

      settled = true;
      cleanup();
      resolve({
        tab_id: tabId,
        url: tab.url,
        title: tab.title,
        status: tab.status
      });
    };

    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId !== tabId) return;
      if (
        changeInfo.status === "complete" ||
        typeof changeInfo.url === "string"
      ) {
        void succeed();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    pollTimer = setInterval(() => {
      void succeed();
    }, POLL_MS) as unknown as number;

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `Page did not become usable within ${Math.round(timeoutMs / 1000)} seconds`
        )
      );
    }, timeoutMs) as unknown as number;

    void succeed();
  });
}


export async function goBackAndWait(
  tabId: number,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<NavigationReadyResult> {
  await chrome.tabs.goBack(tabId);
  return waitForTabUsable(tabId, timeoutMs);
}

export async function reloadAndWait(
  tabId: number,
  options: {
    bypassCache?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<NavigationReadyResult> {
  await chrome.tabs.reload(tabId, {
    bypassCache: options.bypassCache === true
  });
  return waitForTabUsable(
    tabId,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}
