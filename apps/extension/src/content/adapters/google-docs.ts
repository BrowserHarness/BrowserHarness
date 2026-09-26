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

  const active = frameDocument.activeElement;
  if (active instanceof HTMLElement) return active;

  return frameDocument.body instanceof HTMLElement
    ? frameDocument.body
    : null;
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
