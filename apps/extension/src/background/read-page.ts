export interface ReadPageOptions {
  max_chars?: number;
  max_screens?: number;
  start?: number;
  budget_ms?: number;
  step_timeout_ms?: number;
  frame_id?: number;
  frame?: string;
}

export interface ReadableFrame {
  frame_id: number;
  handle: string;
  url: string;
  title: string;
  chars: number;
  interactive: number;
  width: number;
  height: number;
  hidden: boolean;
}

export interface ReadPageResult {
  text: string;
  complete: boolean;
  chars: number;
  total_chars: number;
  screens: number;
  next_start?: number;
  start_out_of_range: boolean;
  scroll_height: number;
  background_tab: boolean;
  stalled: boolean;
  endless_feed: boolean;
  budget_exhausted: boolean;
  shadow_hosts: number;
  frame_id: number;
  frame_handle?: string;
  frames?: ReadableFrame[];
  frames_omitted?: number;
}

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_SCREENS = 40;
const DEFAULT_BUDGET_MS = 15_000;
const DEFAULT_STEP_TIMEOUT_MS = 250;

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function frameIdFromInput(input: ReadPageOptions): number {
  if (
    typeof input.frame_id === "number" &&
    Number.isInteger(input.frame_id) &&
    input.frame_id >= 0
  ) {
    return input.frame_id;
  }

  if (typeof input.frame === "string") {
    const match = /^#?f(\d+)$/i.exec(input.frame.trim());
    if (match) return Number(match[1]);
  }

  return 0;
}

async function scanDocument(options: {
  maxChars: number;
  maxScreens: number;
  start: number;
  budgetMs: number;
  stepTimeoutMs: number;
}) {
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const findScrollRoot = (): HTMLElement => {
    const documentRoot =
      (document.scrollingElement as HTMLElement | null) ||
      document.documentElement;

    if (
      documentRoot &&
      documentRoot.scrollHeight > documentRoot.clientHeight + 1
    ) {
      return documentRoot;
    }

    let best: HTMLElement | null = null;
    let bestArea = 0;

    for (const node of Array.from(
      document.querySelectorAll<HTMLElement>("*")
    ).slice(0, 2500)) {
      if (node.scrollHeight <= node.clientHeight + 100) continue;
      const rect = node.getBoundingClientRect();
      if (
        rect.width < 200 ||
        rect.height < 150 ||
        rect.bottom <= 0 ||
        rect.top >= window.innerHeight
      ) {
        continue;
      }

      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = node;
        bestArea = area;
      }
    }

    return best || documentRoot;
  };

  const root = findScrollRoot();
  const documentRoot =
    (document.scrollingElement as HTMLElement | null) ||
    document.documentElement;
  const isDocumentRoot = root === documentRoot;
  const originalTop = root.scrollTop;
  const seen = new Set<string>();
  const lines: string[] = [];
  let collectedChars = 0;

  const sourceText = () =>
    (isDocumentRoot ? document.body : root)?.innerText || "";

  const harvest = () => {
    let added = 0;
    for (const raw of sourceText().split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      collectedChars += line.length + 1;
      added += 1;
    }
    return added;
  };

  const viewport = () =>
    Math.max(
      1,
      isDocumentRoot ? window.innerHeight : root.clientHeight
    );

  const startedAt = Date.now();
  let screens = 0;
  let stalledSteps = 0;
  let growthAtBottom = 0;
  let previousHeight = root.scrollHeight;
  let reachedEnd = false;
  let endlessFeed = false;
  let budgetExhausted = false;

  try {
    root.scrollTop = 0;
    await sleep(100);
    harvest();

    while (screens < options.maxScreens) {
      if (
        collectedChars >= options.start + options.maxChars
      ) {
        break;
      }

      if (Date.now() - startedAt >= options.budgetMs) {
        budgetExhausted = true;
        break;
      }

      const beforeTop = root.scrollTop;
      const beforeTextLength = sourceText().length;
      const step = Math.max(
        200,
        Math.round(viewport() * 0.85)
      );

      root.scrollTop = beforeTop + step;
      await sleep(options.stepTimeoutMs);

      const added = harvest();
      const moved = root.scrollTop > beforeTop + 1;
      const atBottom =
        root.scrollTop + viewport() >= root.scrollHeight - 2;

      if (added === 0 && !moved) {
        stalledSteps += 1;
      } else {
        stalledSteps = 0;
      }

      if (atBottom && root.scrollHeight > previousHeight + 40) {
        previousHeight = root.scrollHeight;
        growthAtBottom += 1;
        if (growthAtBottom >= 3) {
          endlessFeed = true;
          break;
        }
      }

      screens += 1;

      if (added === 0 && atBottom) {
        reachedEnd = true;
        break;
      }

      if (
        sourceText().length === beforeTextLength &&
        stalledSteps >= 2
      ) {
        break;
      }
    }

    if (
      root.scrollTop + viewport() >= root.scrollHeight - 2 &&
      !endlessFeed
    ) {
      reachedEnd = true;
    }
  } finally {
    root.scrollTop = originalTop;
  }

  const allText = lines.join("\n");
  const start = options.start;
  const text = allText.slice(
    start,
    start + options.maxChars
  );
  const truncated = start + text.length < allText.length;
  const startOutOfRange =
    start > 0 && start >= allText.length;
  let shadowHosts = 0;

  if (allText.length < 200) {
    for (const node of Array.from(
      document.querySelectorAll<HTMLElement>("*")
    ).slice(0, 1500)) {
      if (node.shadowRoot) shadowHosts += 1;
    }
  }

  return {
    text,
    complete:
      reachedEnd &&
      !truncated &&
      !endlessFeed &&
      !budgetExhausted &&
      stalledSteps < 2,
    chars: text.length,
    total_chars: allText.length,
    screens,
    next_start:
      truncated && !endlessFeed ? start + text.length : undefined,
    start_out_of_range: startOutOfRange,
    scroll_height: root.scrollHeight,
    background_tab: document.hidden,
    stalled: stalledSteps >= 2,
    endless_feed: endlessFeed,
    budget_exhausted: budgetExhausted,
    shadow_hosts: shadowHosts
  };
}

function probeFrame() {
  const interactiveSelector =
    'a,button,input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role],[tabindex]:not([tabindex="-1"])';

  return {
    url: location.href,
    title: document.title,
    chars: (document.body?.innerText || "").length,
    interactive:
      document.querySelectorAll(interactiveSelector).length,
    width: window.innerWidth,
    height: window.innerHeight,
    hidden: document.hidden
  };
}

export async function readPage(
  tabId: number,
  input: ReadPageOptions = {}
): Promise<ReadPageResult> {
  const frameId = frameIdFromInput(input);
  const options = {
    maxChars: clampInteger(
      input.max_chars,
      DEFAULT_MAX_CHARS,
      1_000,
      40_000
    ),
    maxScreens: clampInteger(
      input.max_screens,
      DEFAULT_MAX_SCREENS,
      1,
      80
    ),
    start: clampInteger(input.start, 0, 0, 5_000_000),
    budgetMs: clampInteger(
      input.budget_ms,
      DEFAULT_BUDGET_MS,
      1_000,
      30_000
    ),
    stepTimeoutMs: clampInteger(
      input.step_timeout_ms,
      DEFAULT_STEP_TIMEOUT_MS,
      50,
      1_000
    )
  };

  const [scan] = await chrome.scripting.executeScript({
    target: {
      tabId,
      frameIds: [frameId]
    },
    func: scanDocument,
    args: [options]
  });

  if (!scan?.result || typeof scan.result.text !== "string") {
    throw new Error(
      `Frame ${frameId} returned no readable page text`
    );
  }

  let frames: ReadableFrame[] | undefined;
  let framesOmitted: number | undefined;

  if (frameId === 0) {
    try {
      const probed = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: probeFrame
      });

      const readable = probed
        .filter(
          (result) =>
            result.frameId !== 0 &&
            result.result &&
            typeof result.result.url === "string"
        )
        .map((result) => ({
          frame_id: result.frameId,
          handle: `#f${result.frameId}`,
          url: result.result!.url,
          title: result.result!.title,
          chars: result.result!.chars,
          interactive: result.result!.interactive,
          width: result.result!.width,
          height: result.result!.height,
          hidden: result.result!.hidden
        }))
        .sort(
          (a, b) =>
            b.width * b.height - a.width * a.height
        );

      frames = readable.slice(0, 10);
      if (readable.length > frames.length) {
        framesOmitted = readable.length - frames.length;
      }
    } catch {
      frames = undefined;
    }
  }

  return {
    ...scan.result,
    frame_id: frameId,
    ...(frameId === 0
      ? {}
      : { frame_handle: `#f${frameId}` }),
    ...(frames?.length ? { frames } : {}),
    ...(framesOmitted
      ? { frames_omitted: framesOmitted }
      : {})
  };
}
