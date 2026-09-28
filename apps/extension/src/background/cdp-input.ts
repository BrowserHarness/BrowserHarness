import { cdpCommand } from "./cdp-manager";
import { backendNodeForRef } from "./cdp-semantic";

async function enableFocusEmulation(tabId: number): Promise<void> {
  await cdpCommand(
    tabId,
    "Emulation.setFocusEmulationEnabled",
    { enabled: true }
  ).catch(() => undefined);
}

interface BoxModel {
  model?: {
    content?: number[];
    border?: number[];
  };
}

interface ResolvedNode {
  object?: {
    objectId?: string;
  };
}

interface RuntimeValue<T> {
  result?: {
    value?: T;
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

async function resolvedObjectId(
  tabId: number,
  backendNodeId: number
): Promise<string> {
  const resolved = await cdpCommand<ResolvedNode>(
    tabId,
    "DOM.resolveNode",
    { backendNodeId }
  );
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error("Trusted target could not be resolved");
  }
  return objectId;
}

async function targetOwnsPoint(
  tabId: number,
  objectId: string,
  x: number,
  y: number
): Promise<boolean> {
  const result = await cdpCommand<RuntimeValue<boolean>>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function(x,y){const hit=document.elementFromPoint(x,y);return Boolean(hit&&(hit===this||this.contains(hit)));}",
      arguments: [{ value: x }, { value: y }],
      returnByValue: true
    }
  );
  return result.result?.value === true;
}

async function armDeliveryProof(
  tabId: number,
  objectId: string,
  token: string
): Promise<void> {
  await cdpCommand(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function(token){const key='__browsercrewTrustedClickProofs';const root=window;const store=root[key]||(root[key]={});const target=this;const proof={received:false,handler:null};const handler=(event)=>{const node=event.target;proof.received=Boolean(node&&(node===target||target.contains(node)));};proof.handler=handler;store[token]=proof;document.addEventListener('pointerdown',handler,true);document.addEventListener('mousedown',handler,true);return true;}",
      arguments: [{ value: token }],
      returnByValue: true
    }
  );
}

async function collectDeliveryProof(
  tabId: number,
  objectId: string,
  token: string
): Promise<boolean> {
  const result = await cdpCommand<RuntimeValue<boolean>>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function(token){const key='__browsercrewTrustedClickProofs';const store=window[key];const proof=store&&store[token];if(!proof)return false;document.removeEventListener('pointerdown',proof.handler,true);document.removeEventListener('mousedown',proof.handler,true);const received=Boolean(proof.received);delete store[token];return received;}",
      arguments: [{ value: token }],
      returnByValue: true
    }
  );
  return result.result?.value === true;
}

async function targetIsHovered(
  tabId: number,
  objectId: string
): Promise<boolean> {
  const result = await cdpCommand<RuntimeValue<boolean>>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function(){return Boolean(this.matches&&this.matches(':hover'));}",
      returnByValue: true
    }
  );
  return result.result?.value === true;
}

export async function trustedHover(
  tabId: number,
  ref: string
): Promise<{ x: number; y: number }> {
  await enableFocusEmulation(tabId);
  const { x, y, backendNodeId } = await pointForRef(tabId, ref);
  const objectId = await resolvedObjectId(tabId, backendNodeId);

  if (!(await targetOwnsPoint(tabId, objectId, x, y))) {
    throw new Error(
      "Hover target is occluded at the calculated pointer point"
    );
  }

  await cdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none"
  });

  if (!(await targetIsHovered(tabId, objectId))) {
    throw new Error(
      "Hover input was not delivered to the intended target"
    );
  }

  return { x, y };
}

export async function trustedClick(
  tabId: number,
  ref: string
): Promise<{ x: number; y: number }> {
  await enableFocusEmulation(tabId);
  const { x, y, backendNodeId } = await pointForRef(tabId, ref);
  const objectId = await resolvedObjectId(tabId, backendNodeId);

  if (!(await targetOwnsPoint(tabId, objectId, x, y))) {
    throw new Error(
      "Trusted click target is occluded at the calculated click point"
    );
  }

  const proofToken = crypto.randomUUID();
  await armDeliveryProof(tabId, objectId, proofToken);

  let delivered = false;
  try {
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
  } finally {
    delivered = await collectDeliveryProof(
      tabId,
      objectId,
      proofToken
    ).catch(() => false);
  }

  if (!delivered) {
    throw new Error(
      "Trusted click input was not delivered to the intended target"
    );
  }

  return { x, y };
}

export async function trustedType(
  tabId: number,
  ref: string,
  text: string
): Promise<{ typed: number }> {
  await enableFocusEmulation(tabId);
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
  await enableFocusEmulation(tabId);
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
