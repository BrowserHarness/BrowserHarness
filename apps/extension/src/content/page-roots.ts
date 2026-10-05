// Every part of a page BrowserHarness can reach from the top frame's content
// script: the document, open and closed shadow roots, and same-origin iframes
// (nested). Cross-origin iframes stay out of reach here.

export type SearchRoot = Document | ShadowRoot;

export interface RootInfo {
  root: SearchRoot;
  /** Offset of this root's viewport inside the top window (iframes). */
  offsetX: number;
  offsetY: number;
  /** "frame" for iframe documents, "shadow" for shadow roots. */
  kind: "document" | "frame" | "shadow";
}

const MAX_ROOTS = 300;

// Built-in controls (input, video…) have browser-owned shadow roots that hold
// nothing a page author made; skip them.
const NATIVE_SHADOW_HOSTS = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "VIDEO",
  "AUDIO",
  "IMG",
  "METER",
  "PROGRESS",
  "DETAILS",
  "MARQUEE",
  "OBJECT",
  "EMBED"
]);

/** Element check that works across iframe realms (no instanceof). */
export function isElementNode(value: unknown): value is Element {
  return Boolean(value) && typeof value === "object" && (value as Node).nodeType === 1;
}

export function isHtmlElement(value: unknown): value is HTMLElement {
  return isElementNode(value) && value.namespaceURI === "http://www.w3.org/1999/xhtml";
}

function hasTag<T extends HTMLElement>(tag: string) {
  return (value: unknown): value is T => isHtmlElement(value) && value.tagName === tag;
}

export const isInputElement = hasTag<HTMLInputElement>("INPUT");
export const isTextAreaElement = hasTag<HTMLTextAreaElement>("TEXTAREA");
export const isButtonElement = hasTag<HTMLButtonElement>("BUTTON");
export const isSelectElement = hasTag<HTMLSelectElement>("SELECT");

function shadowRootOf(element: Element): ShadowRoot | null {
  if (NATIVE_SHADOW_HOSTS.has(element.tagName)) return null;
  if (element.shadowRoot) return element.shadowRoot;
  // Content scripts may also open closed shadow roots.
  if (!isHtmlElement(element) || typeof chrome === "undefined") return null;
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(element) || null;
  } catch {
    return null;
  }
}

function frameDocument(element: Element): Document | null {
  if (element.tagName !== "IFRAME" && element.tagName !== "FRAME") return null;
  try {
    // null, or a SecurityError, for a cross-origin frame.
    const doc = (element as HTMLIFrameElement).contentDocument;
    return doc?.documentElement ? doc : null;
  } catch {
    return null;
  }
}

/** All reachable roots, the top document first. */
export function collectRoots(doc: Document = document): RootInfo[] {
  const roots: RootInfo[] = [{ root: doc, offsetX: 0, offsetY: 0, kind: "document" }];
  for (let index = 0; index < roots.length && roots.length < MAX_ROOTS; index += 1) {
    const current = roots[index];
    const walker = (current.root.ownerDocument || (current.root as Document)).createTreeWalker(
      current.root,
      NodeFilter.SHOW_ELEMENT
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as Element;
      const shadow = shadowRootOf(element);
      if (shadow) {
        roots.push({ root: shadow, offsetX: current.offsetX, offsetY: current.offsetY, kind: "shadow" });
      }
      const frame = frameDocument(element);
      if (frame) {
        const rect = element.getBoundingClientRect();
        roots.push({
          root: frame,
          offsetX: current.offsetX + rect.left + (element as HTMLElement).clientLeft,
          offsetY: current.offsetY + rect.top + (element as HTMLElement).clientTop,
          kind: "frame"
        });
      }
      if (roots.length >= MAX_ROOTS) break;
    }
  }
  return roots;
}

/** querySelectorAll across every reachable root, each match with its root. */
export function queryAllDeep<T extends Element = HTMLElement>(
  selector: string,
  roots: RootInfo[] = collectRoots()
): Array<{ element: T; info: RootInfo }> {
  const found: Array<{ element: T; info: RootInfo }> = [];
  for (const info of roots) {
    for (const element of Array.from(info.root.querySelectorAll<T>(selector))) {
      found.push({ element, info });
    }
  }
  return found;
}

export function queryDeep<T extends Element = HTMLElement>(
  selector: string,
  roots?: RootInfo[]
): T | null {
  for (const info of roots || collectRoots()) {
    const element = info.root.querySelector<T>(selector);
    if (element) return element;
  }
  return null;
}

/** Whether a rect (in its own frame) shows inside the top window. */
export function inTopViewport(
  rect: { left: number; top: number; right: number; bottom: number },
  info: Pick<RootInfo, "offsetX" | "offsetY">,
  viewport: { width: number; height: number }
): boolean {
  const left = rect.left + info.offsetX;
  const top = rect.top + info.offsetY;
  const right = rect.right + info.offsetX;
  const bottom = rect.bottom + info.offsetY;
  return right > 0 && bottom > 0 && left < viewport.width && top < viewport.height;
}

/** Elements on screen first, each group kept in page order. */
export function viewportFirst<T extends { in_viewport?: boolean }>(items: T[]): T[] {
  return [
    ...items.filter((item) => item.in_viewport !== false),
    ...items.filter((item) => item.in_viewport === false)
  ];
}

/** Highest eN number already stamped anywhere, so new refs never repeat one. */
export function highestRefNumber(refs: Iterable<string | null>): number {
  let highest = 0;
  for (const ref of refs) {
    const match = /^e(\d+)$/.exec(ref || "");
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}
