import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cdpCommand: vi.fn()
}));

vi.mock("./cdp-manager", () => ({
  cdpCommand: mocks.cdpCommand
}));
vi.mock("./cdp-semantic", () => ({
  backendNodeForRef: vi.fn()
}));

import {
  parseTrustedKeySequence,
  trustedSendKeys
} from "./cdp-input";

describe("trusted send_keys", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.cdpCommand.mockResolvedValue({});
  });

  it("resolves Mod to Ctrl on non-Mac platforms", () => {
    const [chord] = parseTrustedKeySequence("Mod+A", "win");
    expect(chord.modifierBits).toBe(2);
    expect(chord.modifiers[0]).toMatchObject({
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17
    });
    expect(chord.key).toMatchObject({
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      text: "a"
    });
  });

  it("resolves Mod to Meta on macOS", () => {
    const [chord] = parseTrustedKeySequence("Mod+A", "mac");
    expect(chord.modifierBits).toBe(4);
    expect(chord.modifiers[0]).toMatchObject({
      key: "Meta",
      code: "MetaLeft",
      windowsVirtualKeyCode: 91
    });
  });

  it("supports named navigation keys, F1-F12 and space-separated sequences", () => {
    const sequence = parseTrustedKeySequence(
      "Shift+Tab ArrowDown F12 Enter",
      "linux"
    );

    expect(sequence).toHaveLength(4);
    expect(sequence[0]).toMatchObject({
      modifierBits: 8,
      key: {
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9
      }
    });
    expect(sequence[1].key).toMatchObject({
      key: "ArrowDown",
      windowsVirtualKeyCode: 40
    });
    expect(sequence[2].key).toMatchObject({
      key: "F12",
      windowsVirtualKeyCode: 123
    });
    expect(sequence[3].key).toMatchObject({
      key: "Enter",
      text: "\r"
    });
  });

  it("dispatches modifier down/base down+up/modifier up and honors repeat", async () => {
    const result = await trustedSendKeys(
      7,
      "Mod+A Shift+Tab",
      2,
      "win"
    );

    expect(result).toEqual({
      keys: "Mod+A Shift+Tab",
      repeat: 2,
      dispatched: 4,
      platform: "win"
    });

    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      1,
      7,
      "Emulation.setFocusEmulationEnabled",
      { enabled: true }
    );

    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      2,
      7,
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        modifiers: 2,
        key: "Control",
        code: "ControlLeft",
        windowsVirtualKeyCode: 17
      }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      3,
      7,
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        modifiers: 2,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65
      }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      4,
      7,
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        modifiers: 2,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65
      }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      5,
      7,
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        modifiers: 0,
        key: "Control",
        code: "ControlLeft",
        windowsVirtualKeyCode: 17
      }
    );

    expect(
      mocks.cdpCommand.mock.calls.filter(
        ([, method]) => method === "Input.dispatchKeyEvent"
      )
    ).toHaveLength(16);
  });

  it("emits shifted printable text only when no non-shift modifier is active", async () => {
    await trustedSendKeys(8, "Shift+a Ctrl+a", 1, "linux");

    const keyDowns = mocks.cdpCommand.mock.calls
      .filter(
        ([, method, params]) =>
          method === "Input.dispatchKeyEvent" &&
          params.type === "keyDown"
      )
      .map(([, , params]) => params);

    expect(keyDowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "A",
          code: "KeyA",
          modifiers: 8,
          text: "A"
        }),
        expect.objectContaining({
          key: "a",
          code: "KeyA",
          modifiers: 2
        })
      ])
    );
    const ctrlA = keyDowns.find(
      (params) => params.key === "a" && params.modifiers === 2
    );
    expect(ctrlA?.text).toBeUndefined();
  });

  it("rejects unsupported keys and out-of-range repeat counts", async () => {
    expect(() =>
      parseTrustedKeySequence("Hyper+Q", "linux")
    ).toThrow("not a modifier");

    expect(() =>
      parseTrustedKeySequence("F13", "linux")
    ).toThrow("unknown key");

    await expect(
      trustedSendKeys(9, "Enter", 101, "linux")
    ).rejects.toThrow("repeat must be an integer");
  });
});
