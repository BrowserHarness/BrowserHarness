import type { RecordedWorkflowStep, WorkflowLocator } from "../runtime/workflows";
import { adapterForUrl } from "./adapters/registry";
import {
  MAX_INTERACTIVE_ELEMENTS,
  compactVisibleText
} from "./observation";
import {
  GOOGLE_DOCS_EDITOR_ID,
  dispatchGoogleDocsText,
  focusGoogleDocsEditor,
  googleDocsEditorTarget,
  isGoogleDocsLocation
} from "./adapters/google-docs";

type ContentRequest =
  | { type: "OBSERVE_PAGE"; tab_id: number }
  | {
      type: "EXECUTE_CONTENT_ACTION";
      action: "click" | "type" | "press_key" | "scroll" | "focus_editor";
      input: Record<string, unknown>;
    }
  | { type: "WATCH_ARM" }
  | { type: "WATCH_DISARM" }
  | { type: "WATCH_REPLAY_STEP"; step: RecordedWorkflowStep };

type ContentRuntimeGlobal = typeof globalThis & {
  __browserharnessContentRuntime?: {
    abortController: AbortController;
    messageListener?: (...args: any[]) => any;
  };
};

const runtimeGlobal = globalThis as ContentRuntimeGlobal;
runtimeGlobal.__browserharnessContentRuntime?.abortController.abort();
if (runtimeGlobal.__browserharnessContentRuntime?.messageListener) {
  chrome.runtime.onMessage.removeListener(
    runtimeGlobal.__browserharnessContentRuntime.messageListener
  );
}
const contentAbortController = new AbortController();

const ID_ATTR = "data-browserharness-id";
const REF_ATTR = "data-browserharness-ref";
let idCounter = 0;
let refCounter = 0;
let recording = false;
let pendingTextElement: HTMLElement | null = null;
let lastInputSignature = "";

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

function ensureSemanticRef(element: HTMLElement): string {
  const existing = element.getAttribute(REF_ATTR);
  if (existing) return `@${existing}`;

  let candidate = "";
  do {
    candidate = `e${++refCounter}`;
  } while (
    document.querySelector(
      `[${REF_ATTR}="${CSS.escape(candidate)}"]`
    )
  );

  element.setAttribute(REF_ATTR, candidate);
  return `@${candidate}`;
}

function semanticSnapshot(
  elements: Array<{
    element_id: string;
    role: string;
    accessible_name: string;
    tag: string;
    disabled: boolean;
    requires_approval?: boolean;
  }>
): string {
  return elements
    .map((element) => {
      const name = element.accessible_name
        ? ` "${element.accessible_name.replace(/\s+/g, " ").trim()}"`
        : "";
      const flags = [
        element.disabled ? "disabled" : "",
        element.requires_approval ? "approval-required" : ""
      ]
        .filter(Boolean)
        .join(",");
      return `${element.element_id} ${element.role}${name} <${element.tag}>${flags ? ` [${flags}]` : ""}`;
    })
    .join("\n");
}

function roleFor(element: HTMLElement): string {
  return (
    element.getAttribute("role") ||
    (element.isContentEditable
      ? "textbox"
      : element.tagName === "A"
        ? "link"
        : element.tagName === "BUTTON"
          ? "button"
          : element.tagName === "INPUT" || element.tagName === "TEXTAREA"
            ? "textbox"
            : element.tagName.toLowerCase())
  );
}

const CONSEQUENTIAL_LABEL =
  /\b(send|submit|publish|buy|purchase|checkout|place order|pay|delete|remove|change password|security|confirm order|complete order)\b/i;

function riskForElement(element: HTMLElement) {
  const name = accessibleName(element);
  const form =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement ||
    element instanceof HTMLSelectElement
      ? element.form
      : element.closest("form");

  const formMethod = (form?.getAttribute("method") || "get").toLowerCase();
  const isSubmitControl =
    (element instanceof HTMLButtonElement && element.type === "submit") ||
    (element instanceof HTMLInputElement &&
      ["submit", "image"].includes(element.type));

  const labelRisk = CONSEQUENTIAL_LABEL.test(name);
  const postSubmitRisk = Boolean(form && isSubmitControl && formMethod !== "get");
  const enterSubmitRisk = Boolean(
    form &&
      formMethod !== "get" &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement)
  );

  return {
    requires_approval: labelRisk || postSubmitRisk,
    approval_reason: labelRisk
      ? `Activate “${name || roleFor(element)}”`
      : postSubmitRisk
        ? "Submit this form"
        : undefined,
    enter_requires_approval: enterSubmitRisk
  };
}

function labelFor(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 160);
  }

  const labels =
    "labels" in element
      ? (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
          .labels
      : null;
  const labelText = labels?.[0]?.textContent
    ?.replace(/\s+/g, " ")
    .trim();
  if (labelText) return labelText.slice(0, 160);

  const closest = element.closest("label")?.textContent
    ?.replace(/\s+/g, " ")
    .trim();
  return closest ? closest.slice(0, 160) : "";
}

function elementText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const RECORDED_ATTRIBUTES = [
  "id",
  "name",
  "type",
  "role",
  "href",
  "aria-label",
  "aria-labelledby",
  "aria-checked",
  "title",
  "placeholder",
  "alt",
  "data-testid"
] as const;

function recordedAttributes(
  element: HTMLElement
): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const name of RECORDED_ATTRIBUTES) {
    const value = element.getAttribute(name)?.trim();
    if (value) attributes[name] = value.slice(0, 240);
  }
  return attributes;
}

function locatorFor(element: HTMLElement): WorkflowLocator {
  const risk = riskForElement(element);
  return {
    tag: element.tagName.toLowerCase(),
    role: roleFor(element),
    accessible_name: accessibleName(element),
    semantic_ref: ensureSemanticRef(element),
    label: labelFor(element) || undefined,
    element_text: elementText(element) || undefined,
    attributes: recordedAttributes(element),
    input_type:
      element instanceof HTMLInputElement ? element.type : undefined,
    requires_approval: risk.requires_approval,
    approval_reason: risk.approval_reason,
    enter_requires_approval: risk.enter_requires_approval
  };
}

function stepContext(description?: string) {
  return {
    id: crypto.randomUUID(),
    recorded_at: new Date().toISOString(),
    url: location.href,
    title: document.title,
    scroll_x: Math.round(window.scrollX),
    scroll_y: Math.round(window.scrollY),
    ...(description ? { description } : {})
  };
}

function interactiveTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('a,button,input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role],[tabindex]:not([tabindex="-1"])');
}

function findByLocator(locator: WorkflowLocator): HTMLElement | null {
  if (locator.semantic_ref?.startsWith("@e")) {
    const direct = document.querySelector<HTMLElement>(
      `[${REF_ATTR}="${CSS.escape(locator.semantic_ref.slice(1))}"]`
    );
    if (
      direct &&
      isVisible(direct) &&
      roleFor(direct) === locator.role &&
      (!locator.accessible_name ||
        accessibleName(direct) === locator.accessible_name)
    ) {
      return direct;
    }
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'a,button,input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role],[tabindex]:not([tabindex="-1"])'
    )
  ).filter(isVisible);

  const ranked = candidates
    .map((element) => {
      const current = locatorFor(element);
      let score = 0;

      if (current.role === locator.role) score += 5;
      if (current.tag === locator.tag) score += 2;
      if (
        locator.accessible_name &&
        current.accessible_name === locator.accessible_name
      ) {
        score += 10;
      }
      if (locator.label && current.label === locator.label) {
        score += 6;
      }
      if (
        locator.input_type &&
        current.input_type === locator.input_type
      ) {
        score += 2;
      }

      for (const key of [
        "data-testid",
        "id",
        "name",
        "placeholder",
        "aria-label"
      ]) {
        const expected = locator.attributes?.[key];
        if (
          expected &&
          current.attributes?.[key] === expected
        ) {
          score += key === "data-testid" || key === "id" ? 6 : 3;
        }
      }

      return { element, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 7) return null;

  const second = ranked[1];
  if (
    second &&
    second.score === best.score &&
    best.score < 12
  ) {
    return null;
  }

  return best.element;
}

function isTextEntryElement(
  element: HTMLElement | null
): element is HTMLElement {
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;

  const type = (element.type || "text").toLowerCase();
  return ![
    "password",
    "checkbox",
    "radio",
    "button",
    "submit",
    "reset",
    "file",
    "image",
    "hidden",
    "range",
    "color"
  ].includes(type);
}

function currentTextValue(element: HTMLElement): string {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.value;
  }
  return element.innerText || element.textContent || "";
}

function takePendingText(
  preferred?: HTMLElement | null
): RecordedWorkflowStep | null {
  const element =
    preferred && isTextEntryElement(preferred)
      ? preferred
      : pendingTextElement;

  if (!recording || !element || !isTextEntryElement(element)) {
    if (preferred === pendingTextElement) {
      pendingTextElement = null;
    }
    return null;
  }

  if (
    element instanceof HTMLInputElement &&
    element.type === "password"
  ) {
    pendingTextElement = null;
    return null;
  }

  const locator = locatorFor(element);
  const text = currentTextValue(element);
  const signature = JSON.stringify({
    tag: locator.tag,
    role: locator.role,
    name: locator.accessible_name,
    label: locator.label,
    text
  });

  if (signature === lastInputSignature) {
    if (element === pendingTextElement) {
      pendingTextElement = null;
    }
    return null;
  }

  lastInputSignature = signature;
  if (element === pendingTextElement) {
    pendingTextElement = null;
  }

  return {
    ...stepContext(),
    action: "type",
    locator,
    text
  };
}

function emitRecordedStep(step: RecordedWorkflowStep): void {
  void chrome.runtime
    .sendMessage({
      type: "WATCH_CAPTURE_STEP",
      step
    })
    .catch(() => undefined);
}

function flushPendingText(
  preferred?: HTMLElement | null
): void {
  const step = takePendingText(preferred);
  if (step) emitRecordedStep(step);
}

function recordClick(
  element: HTMLElement,
  event?: PointerEvent | MouseEvent
): void {
  flushPendingText();
  emitRecordedStep({
    ...stepContext(),
    action: "click",
    locator: locatorFor(element),
    ...(event &&
    Number.isFinite(event.clientX) &&
    Number.isFinite(event.clientY)
      ? {
          pointer: {
            x: Math.round(event.clientX),
            y: Math.round(event.clientY)
          }
        }
      : {})
  });
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (!recording) return;
    const element = interactiveTarget(event.target);
    if (!element) return;
    recordClick(element, event);
  },
  { capture: true, signal: contentAbortController.signal }
);

document.addEventListener(
  "click",
  (event) => {
    if (!recording || event.detail !== 0) return;
    const element = interactiveTarget(event.target);
    if (!element) return;
    recordClick(element, event);
  },
  { capture: true, signal: contentAbortController.signal }
);

document.addEventListener(
  "input",
  (event) => {
    if (!recording) return;
    const element = interactiveTarget(event.target);
    if (!element || !isTextEntryElement(element)) return;
    if (
      element instanceof HTMLInputElement &&
      element.type === "password"
    ) {
      return;
    }
    pendingTextElement = element;
  },
  { capture: true, signal: contentAbortController.signal }
);

document.addEventListener(
  "change",
  (event) => {
    if (!recording) return;
    const element = interactiveTarget(event.target);
    if (!element || !isTextEntryElement(element)) return;
    flushPendingText(element);
  },
  { capture: true, signal: contentAbortController.signal }
);

document.addEventListener(
  "focusout",
  (event) => {
    if (!recording) return;
    const element = interactiveTarget(event.target);
    if (!element || !isTextEntryElement(element)) return;
    flushPendingText(element);
  },
  { capture: true, signal: contentAbortController.signal }
);

document.addEventListener(
  "keydown",
  (event) => {
    if (!recording) return;
    if (event.key !== "Enter" && event.key !== "Tab") return;

    flushPendingText();
    const active =
      document.activeElement instanceof HTMLElement
        ? interactiveTarget(document.activeElement)
        : null;

    emitRecordedStep({
      ...stepContext(),
      action: "key",
      key: event.key,
      ...(active ? { locator: locatorFor(active) } : {})
    });
  },
  { capture: true, signal: contentAbortController.signal }
);

function observe(tabId: number) {
  const selector =
    'a,button,input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role],[tabindex]:not([tabindex="-1"])';
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter(isVisible)
    .slice(0, MAX_INTERACTIVE_ELEMENTS)
    .map((element) => {
      const semanticRef = ensureSemanticRef(element);
      ensureId(element);
      return {
      element_id: semanticRef,
      semantic_ref: semanticRef,
      tag: element.tagName.toLowerCase(),
      role: roleFor(element),
      accessible_name: accessibleName(element),
      type:
        element instanceof HTMLInputElement || element instanceof HTMLButtonElement
          ? element.type
          : undefined,
      visible: true,
      disabled:
        "disabled" in element &&
        Boolean((element as HTMLButtonElement | HTMLInputElement).disabled),
      ...riskForElement(element)
    };
    });

  const googleDocsEditor = googleDocsEditorTarget();
  if (
    googleDocsEditor &&
    !elements.some((element) => element.element_id === GOOGLE_DOCS_EDITOR_ID)
  ) {
    elements.unshift({
      element_id: GOOGLE_DOCS_EDITOR_ID,
      semantic_ref: GOOGLE_DOCS_EDITOR_ID,
      tag: "google-docs-editor",
      role: "textbox",
      accessible_name: "Document content",
      type: undefined,
      visible: true,
      disabled: false,
      requires_approval: false,
      approval_reason: undefined,
      enter_requires_approval: false
    });
  }

  return {
    tab_id: tabId,
    url: location.href,
    title: document.title,
    visible_text: compactVisibleText(document.body?.innerText || ""),
    snapshot: semanticSnapshot(elements),
    elements,
    adapter: adapterForUrl(location.href)
  };
}

function getElement(id: unknown): HTMLElement {
  if (typeof id !== "string") throw new Error("Missing element_id");
  if (id === GOOGLE_DOCS_EDITOR_ID) {
    const editor = googleDocsEditorTarget();
    if (!editor) throw new Error("Google Docs editor target not found");
    return editor;
  }

  const element = id.startsWith("@e")
    ? document.querySelector<HTMLElement>(
        `[${REF_ATTR}="${CSS.escape(id.slice(1))}"]`
      )
    : document.querySelector<HTMLElement>(
        `[${ID_ATTR}="${CSS.escape(id)}"]`
      );

  if (!element) throw new Error("Element not found");
  return element;
}

function dispatchBeforeInput(
  element: HTMLElement,
  text: string
): void {
  try {
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      })
    );
  } catch {
    // Older pages may not support constructing beforeinput directly.
  }
}

function setNativeControlValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(
    prototype,
    "value"
  )?.set;

  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

function insertContentEditableText(
  element: HTMLElement,
  text: string,
  replace: boolean
): void {
  const ownerDocument = element.ownerDocument;
  const selection = ownerDocument.getSelection();

  if (replace) {
    const range = ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  dispatchBeforeInput(element, text);

  let inserted = false;
  try {
    inserted = ownerDocument.execCommand(
      "insertText",
      false,
      text
    );
  } catch {
    inserted = false;
  }

  if (!inserted) {
    const activeSelection = ownerDocument.getSelection();
    let range =
      activeSelection && activeSelection.rangeCount > 0
        ? activeSelection.getRangeAt(0)
        : null;

    if (!range) {
      range = ownerDocument.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }

    if (replace) {
      range.deleteContents();
    }

    const node = ownerDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    activeSelection?.removeAllRanges();
    activeSelection?.addRange(range);
  }

  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    })
  );
}

function writeText(
  element: HTMLElement,
  text: string,
  replace = true
) {
  element.focus();

  if (
    isGoogleDocsLocation(location) &&
    element.ownerDocument !== document
  ) {
    return dispatchGoogleDocsText(element, text);
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    if (
      element instanceof HTMLInputElement &&
      element.type === "password"
    ) {
      throw new Error(
        "Password fields are not replayed by Watch Me"
      );
    }

    const nextValue = replace
      ? text
      : `${element.value}${text}`;

    dispatchBeforeInput(element, text);
    setNativeControlValue(element, nextValue);
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      })
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true })
    );

    return {
      typed: text.length,
      editor: "form-control",
      mode: "native-value"
    };
  }

  if (element.isContentEditable) {
    insertContentEditableText(element, text, replace);
    return {
      typed: text.length,
      editor: "contenteditable",
      mode: "contenteditable"
    };
  }

  throw new Error("Element is not text-editable");
}

function execute(action: Extract<ContentRequest, { type: "EXECUTE_CONTENT_ACTION" }>) {
  const { input } = action;
  switch (action.action) {
    case "focus_editor": {
      if (!focusGoogleDocsEditor()) {
        throw new Error("Google Docs editor target not found");
      }
      return { focused: GOOGLE_DOCS_EDITOR_ID };
    }
    case "click": {
      if (input.element_id === GOOGLE_DOCS_EDITOR_ID) {
        // Clicking the hidden editor frame does nothing useful: focus it and
        // tell the planner what to do next so it does not keep clicking.
        if (!focusGoogleDocsEditor()) {
          throw new Error("Google Docs editor target not found");
        }
        return {
          focused: GOOGLE_DOCS_EDITOR_ID,
          next: `The document is ready for text. Write it with type and element_id ${GOOGLE_DOCS_EDITOR_ID}.`
        };
      }
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
  if (step.action === "key") {
    const locator = step.locator;
    const element = locator
      ? findByLocator(locator)
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (locator && !element) {
      throw new Error(
        `Recorded element not found: ${locator.accessible_name || locator.role}`
      );
    }

    element?.focus();
    element?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: step.key,
        bubbles: true
      })
    );
    element?.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: step.key,
        bubbles: true
      })
    );
    return { action: "key", key: step.key };
  }

  if (step.action === "click") {
    const element = findByLocator(step.locator);
    if (!element) {
      throw new Error(
        `Recorded element not found: ${step.locator.accessible_name || step.locator.role}`
      );
    }
    element.scrollIntoView({
      block: "center",
      inline: "nearest"
    });
    element.click();
    return { action: "click" };
  }

  const element = findByLocator(step.locator);
  if (!element) {
    throw new Error(
      `Recorded element not found: ${step.locator.accessible_name || step.locator.role}`
    );
  }
  element.scrollIntoView({
    block: "center",
    inline: "nearest"
  });
  return writeText(element, step.text, true);
}

const contentMessageListener = (
  request: ContentRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => {
  try {
    if (request.type === "OBSERVE_PAGE") {
      sendResponse({ ok: true, data: observe(request.tab_id) });
      return;
    }
    if (request.type === "EXECUTE_CONTENT_ACTION") {
      sendResponse({ ok: true, data: execute(request) });
      return;
    }
    if (request.type === "WATCH_ARM") {
      recording = true;
      pendingTextElement = null;
      lastInputSignature = "";
      sendResponse({
        ok: true,
        data: {
          recording: true,
          url: location.href,
          title: document.title
        }
      });
      return;
    }
    if (request.type === "WATCH_DISARM") {
      const finalStep = takePendingText();
      recording = false;
      pendingTextElement = null;
      sendResponse({
        ok: true,
        data: {
          recording: false,
          final_step: finalStep || undefined,
          url: location.href,
          title: document.title
        }
      });
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
        code:
          error instanceof Error && /not found/i.test(error.message)
            ? "ELEMENT_NOT_FOUND"
            : "INTERNAL_ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Unknown content-script error"
      }
    });
  }
};

chrome.runtime.onMessage.addListener(contentMessageListener);
runtimeGlobal.__browserharnessContentRuntime = {
  abortController: contentAbortController,
  messageListener: contentMessageListener
};
