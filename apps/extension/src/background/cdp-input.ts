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

interface TrustedModifierSpec {
  bit: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
}

interface TrustedKeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

export interface TrustedKeyChord {
  modifierBits: number;
  modifiers: TrustedModifierSpec[];
  key: TrustedKeySpec;
}

const TRUSTED_MODIFIERS: Record<string, TrustedModifierSpec> = {
  alt: {
    bit: 1,
    key: "Alt",
    code: "AltLeft",
    windowsVirtualKeyCode: 18
  },
  ctrl: {
    bit: 2,
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17
  },
  control: {
    bit: 2,
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17
  },
  cmd: {
    bit: 4,
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91
  },
  meta: {
    bit: 4,
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91
  },
  shift: {
    bit: 8,
    key: "Shift",
    code: "ShiftLeft",
    windowsVirtualKeyCode: 16
  }
};

const TRUSTED_NAMED_KEYS: Record<string, TrustedKeySpec> = {
  enter: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r"
  },
  return: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r"
  },
  escape: {
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  },
  esc: {
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  },
  tab: {
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9
  },
  backspace: {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8
  },
  delete: {
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46
  },
  space: {
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    text: " "
  },
  arrowup: {
    key: "ArrowUp",
    code: "ArrowUp",
    windowsVirtualKeyCode: 38
  },
  arrowdown: {
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40
  },
  arrowleft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37
  },
  arrowright: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39
  },
  home: {
    key: "Home",
    code: "Home",
    windowsVirtualKeyCode: 36
  },
  end: {
    key: "End",
    code: "End",
    windowsVirtualKeyCode: 35
  },
  pageup: {
    key: "PageUp",
    code: "PageUp",
    windowsVirtualKeyCode: 33
  },
  pagedown: {
    key: "PageDown",
    code: "PageDown",
    windowsVirtualKeyCode: 34
  }
};

function trustedBaseKey(token: string): TrustedKeySpec {
  const lowered = token.toLowerCase();
  const named = TRUSTED_NAMED_KEYS[lowered];
  if (named) return named;

  const functionKey = /^f(\d{1,2})$/i.exec(token);
  if (functionKey) {
    const number = Number(functionKey[1]);
    if (number >= 1 && number <= 12) {
      return {
        key: `F${number}`,
        code: `F${number}`,
        windowsVirtualKeyCode: 111 + number
      };
    }
  }

  if (/^[a-zA-Z]$/.test(token)) {
    const upper = token.toUpperCase();
    return {
      key: token.toLowerCase(),
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: token.toLowerCase()
    };
  }

  if (/^[0-9]$/.test(token)) {
    return {
      key: token,
      code: `Digit${token}`,
      windowsVirtualKeyCode: token.charCodeAt(0),
      text: token
    };
  }

  throw new Error(
    `send_keys: unknown key "${token}". Supported named keys: ${Object.keys(
      TRUSTED_NAMED_KEYS
    ).join(", ")}, F1-F12, single letters/digits.`
  );
}

export function parseTrustedKeySequence(
  keys: string,
  platform: string
): TrustedKeyChord[] {
  const source = keys.trim();
  if (!source) {
    throw new Error(
      'send_keys: keys is required, e.g. "Enter", "Mod+A", "Shift+Tab", or "Enter Escape"'
    );
  }

  const mod =
    platform === "mac"
      ? TRUSTED_MODIFIERS.cmd
      : TRUSTED_MODIFIERS.ctrl;

  return source.split(/\s+/).map((segment) => {
    const tokens = segment
      .split("+")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!tokens.length) {
      throw new Error("send_keys: empty key segment");
    }

    let modifierBits = 0;
    const modifiers: TrustedModifierSpec[] = [];

    for (const token of tokens.slice(0, -1)) {
      const lowered = token.toLowerCase();
      const modifier =
        lowered === "mod" ? mod : TRUSTED_MODIFIERS[lowered];
      if (!modifier) {
        throw new Error(
          `send_keys: "${token}" is not a modifier; use Alt/Ctrl/Cmd/Meta/Shift or Mod`
        );
      }
      modifierBits |= modifier.bit;
      modifiers.push(modifier);
    }

    return {
      modifierBits,
      modifiers,
      key: trustedBaseKey(tokens[tokens.length - 1])
    };
  });
}

function shiftedTrustedKey(
  key: TrustedKeySpec,
  shift: boolean
): TrustedKeySpec {
  if (
    !shift ||
    key.key.length !== 1 ||
    !/^[a-z]$/.test(key.key)
  ) {
    return key;
  }

  const upper = key.key.toUpperCase();
  return {
    ...key,
    key: upper,
    text: upper
  };
}

export async function trustedSendKeys(
  tabId: number,
  keys: string,
  repeat: number,
  platform: string
): Promise<{
  keys: string;
  repeat: number;
  dispatched: number;
  platform: string;
}> {
  const boundedRepeat = Number(repeat);
  if (
    !Number.isInteger(boundedRepeat) ||
    boundedRepeat < 1 ||
    boundedRepeat > 100
  ) {
    throw new Error(
      "send_keys: repeat must be an integer in [1, 100]"
    );
  }

  const chords = parseTrustedKeySequence(keys, platform);
  await enableFocusEmulation(tabId);

  let dispatched = 0;
  for (
    let iteration = 0;
    iteration < boundedRepeat;
    iteration += 1
  ) {
    for (const chord of chords) {
      const base = shiftedTrustedKey(
        chord.key,
        (chord.modifierBits & TRUSTED_MODIFIERS.shift.bit) !== 0
      );

      let activeModifiers = 0;
      for (const modifier of chord.modifiers) {
        activeModifiers |= modifier.bit;
        await cdpCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          modifiers: activeModifiers,
          key: modifier.key,
          code: modifier.code,
          windowsVirtualKeyCode:
            modifier.windowsVirtualKeyCode
        });
      }

      const printableText =
        (chord.modifierBits & ~TRUSTED_MODIFIERS.shift.bit) === 0 &&
        base.text !== undefined
          ? { text: base.text }
          : {};

      await cdpCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        modifiers: chord.modifierBits,
        key: base.key,
        code: base.code,
        windowsVirtualKeyCode: base.windowsVirtualKeyCode,
        ...printableText
      });
      await cdpCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: chord.modifierBits,
        key: base.key,
        code: base.code,
        windowsVirtualKeyCode: base.windowsVirtualKeyCode
      });

      for (
        let index = chord.modifiers.length - 1;
        index >= 0;
        index -= 1
      ) {
        const modifier = chord.modifiers[index];
        activeModifiers &= ~modifier.bit;
        await cdpCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers: activeModifiers,
          key: modifier.key,
          code: modifier.code,
          windowsVirtualKeyCode:
            modifier.windowsVirtualKeyCode
        });
      }

      dispatched += 1;
    }
  }

  return {
    keys,
    repeat: boundedRepeat,
    dispatched,
    platform
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

async function armDragDeliveryProof(
  tabId: number,
  sourceObjectId: string,
  targetObjectId: string,
  token: string
): Promise<void> {
  await cdpCommand(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId: sourceObjectId,
      functionDeclaration:
        "function(token,target){const key='__browsercrewTrustedDragProofs';const store=window[key]||(window[key]={});const source=this;const owns=(root,node)=>Boolean(root&&node&&(node===root||root.contains(node)));const proof={down:false,up:false,downHandler:null,upHandler:null};const down=(event)=>{if(owns(source,event.target))proof.down=true;};const up=(event)=>{if(owns(target,event.target))proof.up=true;};proof.downHandler=down;proof.upHandler=up;store[token]=proof;document.addEventListener('pointerdown',down,true);document.addEventListener('mousedown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('mouseup',up,true);return true;}",
      arguments: [
        { value: token },
        { objectId: targetObjectId }
      ],
      returnByValue: true
    }
  );
}

async function collectDragDeliveryProof(
  tabId: number,
  token: string
): Promise<boolean> {
  const encodedToken = JSON.stringify(token);
  const result = await cdpCommand<RuntimeValue<boolean>>(
    tabId,
    "Runtime.evaluate",
    {
      expression:
        "(function(){const key='__browsercrewTrustedDragProofs';const store=window[key];const proof=store&&store[" +
        encodedToken +
        "];if(!proof)return false;document.removeEventListener('pointerdown',proof.downHandler,true);document.removeEventListener('mousedown',proof.downHandler,true);document.removeEventListener('pointerup',proof.upHandler,true);document.removeEventListener('mouseup',proof.upHandler,true);const delivered=Boolean(proof.down&&proof.up);delete store[" +
        encodedToken +
        "];return delivered;})()",
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

export async function trustedDrag(
  tabId: number,
  sourceRef: string,
  targetRef: string,
  steps = 8
): Promise<{
  source: { x: number; y: number };
  target: { x: number; y: number };
  steps: number;
}> {
  await enableFocusEmulation(tabId);

  const boundedSteps = Math.min(
    Math.max(Math.round(Number(steps) || 8), 2),
    30
  );
  const sourceBackendNodeId = backendNodeForRef(tabId, sourceRef);
  const targetBackendNodeId = backendNodeForRef(tabId, targetRef);

  await cdpCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
    backendNodeId: sourceBackendNodeId
  });
  await cdpCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
    backendNodeId: targetBackendNodeId
  });

  const [sourceBox, targetBox] = await Promise.all([
    cdpCommand<BoxModel>(tabId, "DOM.getBoxModel", {
      backendNodeId: sourceBackendNodeId
    }),
    cdpCommand<BoxModel>(tabId, "DOM.getBoxModel", {
      backendNodeId: targetBackendNodeId
    })
  ]);

  const source = quadCenter(
    sourceBox.model?.content || sourceBox.model?.border
  );
  const target = quadCenter(
    targetBox.model?.content || targetBox.model?.border
  );

  const sourceObjectId = await resolvedObjectId(
    tabId,
    sourceBackendNodeId
  );
  const targetObjectId = await resolvedObjectId(
    tabId,
    targetBackendNodeId
  );

  if (
    !(await targetOwnsPoint(
      tabId,
      sourceObjectId,
      source.x,
      source.y
    ))
  ) {
    throw new Error(
      "Drag source is occluded at the calculated pointer point"
    );
  }
  if (
    !(await targetOwnsPoint(
      tabId,
      targetObjectId,
      target.x,
      target.y
    ))
  ) {
    throw new Error(
      "Drag target is occluded at the calculated pointer point"
    );
  }

  const proofToken = crypto.randomUUID();
  await armDragDeliveryProof(
    tabId,
    sourceObjectId,
    targetObjectId,
    proofToken
  );

  let delivered = false;
  try {
    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: source.x,
      y: source.y,
      button: "none"
    });
    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: source.x,
      y: source.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });

    for (let index = 1; index <= boundedSteps; index += 1) {
      const progress = index / boundedSteps;
      await cdpCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: source.x + (target.x - source.x) * progress,
        y: source.y + (target.y - source.y) * progress,
        button: "left",
        buttons: 1
      });
    }

    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  } finally {
    delivered = await collectDragDeliveryProof(
      tabId,
      proofToken
    ).catch(() => false);
  }

  if (!delivered) {
    throw new Error(
      "Drag input was not delivered from the intended source to target"
    );
  }

  return {
    source,
    target,
    steps: boundedSteps
  };
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
