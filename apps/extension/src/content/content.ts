import type { RecordedWorkflowStep, WorkflowLocator } from "../runtime/workflows";

type ContentRequest =
  | { type: "OBSERVE_PAGE"; tab_id: number }
  | {
      type: "EXECUTE_CONTENT_ACTION";
      action: "click" | "type" | "press_key" | "scroll";
      input: Record<string, unknown>;
    }
  | { type: "WATCH_START" }
  | { type: "WATCH_STOP" }
  | { type: "WATCH_REPLAY_STEP"; step: RecordedWorkflowStep };

const ID_ATTR = "data-browsercrew-id";
let idCounter = 0;
let recording = false;
let recordedSteps: RecordedWorkflowStep[] = [];

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function accessibleName(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    (element instanceof HTMLInputElement ? element.placeholder || element.name : "") ||
    element.innerText ||
    element.textContent ||
    ""
  ).trim().slice(0, 240);
}

function ensureId(element: HTMLElement): string {
  const existing = element.getAttribute(ID_ATTR);
  if (existing) return existing;
  const id = `bc-${++idCounter}`;
  element.setAttribute(ID_ATTR, id);
  return id;
}

function roleFor(element: HTMLElement): string {
  return (
    element.getAttribute("role") ||
    (element.tagName === "A"
      ? "link"
      : element.tagName === "BUTTON"
        ? "button"
        : element.tagName === "INPUT"
          ? "textbox"
          : element.tagName.toLowerCase())
  );
}

function locatorFor(element: HTMLElement): WorkflowLocator {
  return {
    tag: element.tagName.toLowerCase(),
    role: roleFor(element),
    accessible_name: accessibleName(element),
    input_type: element instanceof HTMLInputElement ? element.type : undefined
  };
}

function interactiveTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('a,button,input,textarea,select,[role],[tabindex]:not([tabindex="-1"])');
}

function findByLocator(locator: WorkflowLocator): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('a,button,input,textarea,select,[role],[tabindex]:not([tabindex="-1"])')
  ).filter(isVisible);

  return (
    candidates.find((element) => {
      const current = locatorFor(element);
      return (
        current.tag === locator.tag &&
        current.role === locator.role &&
        current.accessible_name === locator.accessible_name
      );
    }) ||
    candidates.find((element) => {
      const current = locatorFor(element);
      return current.role === locator.role && current.accessible_name === locator.accessible_name;
    }) ||
    null
  );
}

document.addEventListener(
  "click",
  (event) => {
    if (!recording) return;
    const element = interactiveTarget(event.target);
    if (!element) return;
    recordedSteps.push({ action: "click", locator: locatorFor(element) });
  },
  true
);

document.addEventListener(
  "change",
  (event) => {
    if (!recording) return;
    const element = interactiveTarget(event.target);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    if (element instanceof HTMLInputElement && element.type === "password") return;
    recordedSteps.push({
      action: "type",
      locator: locatorFor(element),
      text: element.value
    });
  },
  true
);

function observe(tabId: number) {
  const selector =
    'a,button,input,textarea,select,[role],[tabindex]:not([tabindex="-1"])';
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter(isVisible)
    .slice(0, 500)
    .map((element) => ({
      element_id: ensureId(element),
      tag: element.tagName.toLowerCase(),
      role: roleFor(element),
      accessible_name: accessibleName(element),
      type: element instanceof HTMLInputElement ? element.type : undefined,
      visible: true,
      disabled:
        "disabled" in element && Boolean((element as HTMLButtonElement | HTMLInputElement).disabled)
    }));

  return {
    tab_id: tabId,
    url: location.href,
    title: document.title,
    visible_text: (document.body?.innerText || "").slice(0, 20_000),
    elements
  };
}

function getElement(id: unknown): HTMLElement {
  if (typeof id !== "string") throw new Error("Missing element_id");
  const element = document.querySelector<HTMLElement>(`[${ID_ATTR}="${CSS.escape(id)}"]`);
  if (!element) throw new Error("Element not found");
  return element;
}

function writeText(element: HTMLElement, text: string, replace = true) {
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element instanceof HTMLInputElement && element.type === "password") {
      throw new Error("Password fields are not replayed by Watch Me");
    }
    if (replace) element.value = "";
    element.value += text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: text.length };
  }
  throw new Error("Element is not text-editable");
}

function execute(action: Extract<ContentRequest, { type: "EXECUTE_CONTENT_ACTION" }>) {
  const { input } = action;
  switch (action.action) {
    case "click": {
      const element = getElement(input.element_id);
      element.scrollIntoView({ block: "center", inline: "nearest" });
      element.click();
      return { clicked: String(input.element_id) };
    }
    case "type":
      return writeText(getElement(input.element_id), String(input.text ?? ""), input.replace !== false);
    case "press_key": {
      const element =
        typeof input.element_id === "string" ? getElement(input.element_id) : document.activeElement;
      const key = String(input.key ?? "");
      element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      element?.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      return { key };
    }
    case "scroll": {
      const direction = String(input.direction ?? "down");
      const amount = Number(input.amount ?? Math.round(window.innerHeight * 0.75));
      const y = direction === "up" ? -Math.abs(amount) : Math.abs(amount);
      window.scrollBy({ top: y, behavior: "smooth" });
      return { direction, amount };
    }
  }
}

function replayStep(step: RecordedWorkflowStep) {
  const element = findByLocator(step.locator);
  if (!element) throw new Error(`Recorded element not found: ${step.locator.accessible_name || step.locator.role}`);
  element.scrollIntoView({ block: "center", inline: "nearest" });
  if (step.action === "click") {
    element.click();
    return { action: "click" };
  }
  return writeText(element, step.text, true);
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  try {
    if (request.type === "OBSERVE_PAGE") {
      sendResponse({ ok: true, data: observe(request.tab_id) });
      return;
    }
    if (request.type === "EXECUTE_CONTENT_ACTION") {
      sendResponse({ ok: true, data: execute(request) });
      return;
    }
    if (request.type === "WATCH_START") {
      recording = true;
      recordedSteps = [];
      sendResponse({ ok: true, data: { recording: true } });
      return;
    }
    if (request.type === "WATCH_STOP") {
      recording = false;
      sendResponse({ ok: true, data: { steps: recordedSteps } });
      return;
    }
    if (request.type === "WATCH_REPLAY_STEP") {
      sendResponse({ ok: true, data: replayStep(request.step) });
      return;
    }
  } catch (error) {
    sendResponse({
      ok: false,
      error: {
        code: error instanceof Error && /not found/i.test(error.message) ? "ELEMENT_NOT_FOUND" : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown content-script error"
      }
    });
  }
});
