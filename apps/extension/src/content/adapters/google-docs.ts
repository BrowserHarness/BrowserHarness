export const GOOGLE_DOCS_EDITOR_ID = "bc-google-doc-editor";

export function isGoogleDocsLocation(locationLike: Pick<Location, "hostname">): boolean {
  return locationLike.hostname === "docs.google.com";
}

export function googleDocsEditorTarget(doc: Document = document): HTMLElement | null {
  if (!isGoogleDocsLocation(window.location)) return null;

  const iframe = doc.querySelector<HTMLIFrameElement>(
    ".docs-texteventtarget-iframe"
  );
  const frameDocument = iframe?.contentDocument;
  if (!frameDocument) return null;

  // The editor lives in another frame, so its nodes come from a different
  // realm and fail `instanceof HTMLElement` here: check the node type instead.
  const active = frameDocument.activeElement;
  if (isElementNode(active) && active !== frameDocument.documentElement) {
    return active;
  }
  return isElementNode(frameDocument.body) ? frameDocument.body : null;
}

function isElementNode(node: unknown): node is HTMLElement {
  return Boolean(
    node &&
      typeof node === "object" &&
      (node as Node).nodeType === 1 &&
      typeof (node as HTMLElement).focus === "function"
  );
}

/** Put keyboard focus in the Google Docs editor so real input reaches it. */
export function focusGoogleDocsEditor(doc: Document = document): HTMLElement | null {
  const editor = googleDocsEditorTarget(doc);
  if (!editor) return null;
  editor.ownerDocument.defaultView?.focus();
  editor.focus();
  return editor;
}

export function dispatchGoogleDocsText(
  element: HTMLElement,
  text: string
): { typed: number; editor: string } {
  const ownerDocument = element.ownerDocument;
  element.focus();
  ownerDocument.defaultView?.focus();

  for (const char of text) {
    const keyCode = char === "\n" ? 13 : char.charCodeAt(0);
    const event = ownerDocument.createEvent("Event");
    event.initEvent("keypress", true, true);
    Object.defineProperty(event, "key", {
      value: char === "\n" ? "Enter" : char
    });
    Object.defineProperty(event, "keyCode", { value: keyCode });
    Object.defineProperty(event, "which", { value: keyCode });
    Object.defineProperty(event, "charCode", {
      value: char === "\n" ? 0 : keyCode
    });
    element.dispatchEvent(event);
  }

  return {
    typed: text.length,
    editor: "google-docs-text-event-target"
  };
}
