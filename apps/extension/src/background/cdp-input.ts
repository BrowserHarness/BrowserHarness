import { cdpCommand } from "./cdp-manager";
import { backendNodeForRef } from "./cdp-semantic";

interface BoxModel {
  model?: {
    content?: number[];
    border?: number[];
  };
}

function quadCenter(quad?: number[]): { x: number; y: number } {
  if (!quad || quad.length < 8) {
    throw new Error("Target has no usable layout box");
  }

  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length
  };
}

async function pointForRef(
  tabId: number,
  ref: string
): Promise<{ x: number; y: number; backendNodeId: number }> {
  const backendNodeId = backendNodeForRef(tabId, ref);

  await cdpCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
    backendNodeId
  });

  const box = await cdpCommand<BoxModel>(
    tabId,
    "DOM.getBoxModel",
    { backendNodeId }
  );

  const { x, y } = quadCenter(
    box.model?.content || box.model?.border
  );

  return { x, y, backendNodeId };
}

export async function trustedClick(
  tabId: number,
  ref: string
): Promise<{ x: number; y: number }> {
  const { x, y } = await pointForRef(tabId, ref);

  await cdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none"
  });
  await cdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1
  });
  await cdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1
  });

  return { x, y };
}

export async function trustedType(
  tabId: number,
  ref: string,
  text: string
): Promise<{ typed: number }> {
  const backendNodeId = backendNodeForRef(tabId, ref);

  await cdpCommand(tabId, "DOM.focus", {
    backendNodeId
  });
  await cdpCommand(tabId, "Input.insertText", {
    text
  });

  return { typed: text.length };
}

export async function trustedKey(
  tabId: number,
  key: string
): Promise<{ key: string }> {
  const code =
    key === "Enter"
      ? "Enter"
      : key === "Tab"
        ? "Tab"
        : key.length === 1
          ? `Key${key.toUpperCase()}`
          : key;

  await cdpCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    ...(key.length === 1 ? { text: key } : {})
  });
  await cdpCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code
  });

  return { key };
}
