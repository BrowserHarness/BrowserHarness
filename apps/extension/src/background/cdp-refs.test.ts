import { beforeEach, describe, expect, it, vi } from "vitest";

// A page whose DOM the test controls: element and text nodes with backend ids,
// ref attributes, one shadow root and one iframe document.
const page = vi.hoisted(() => ({
  attributes: new Map<number, string>(),
  root: null as unknown,
  ax: [] as unknown[],
  calls: [] as string[]
}));

vi.mock("./cdp-manager", () => ({
  cdpCommand: async (_tab: number, method: string, params: Record<string, unknown> = {}) => {
    page.calls.push(method);
    if (method === "Accessibility.getFullAXTree") return { nodes: page.ax };
    if (method === "DOM.getDocument") return { root: page.root };
    if (method === "DOM.setAttributeValue") {
      page.attributes.set(Number(params.nodeId), String(params.value));
      return {};
    }
    if (method === "DOM.describeNode") {
      const id = Number(params.backendNodeId);
      return { node: { nodeId: id, backendNodeId: id, nodeType: 1, attributes: attrs(id) } };
    }
    if (method === "Accessibility.getPartialAXTree") {
      return { nodes: [{ nodeId: "x", name: { value: "Delete account" } }] };
    }
    throw new Error(`unexpected ${method}`);
  }
}));

function attrs(id: number): string[] {
  const ref = page.attributes.get(id);
  return ref ? ["data-browserharness-ref", ref] : [];
}

const element = (id: number, extra: Record<string, unknown> = {}) => ({
  nodeId: id,
  backendNodeId: id,
  nodeType: 1,
  get attributes() {
    return attrs(id);
  },
  ...extra
});

import {
  accessibleNameForRef,
  backendNodeForRef,
  captureAxSnapshot
} from "./cdp-semantic";

describe("one @e ref system for every tool", () => {
  beforeEach(() => {
    page.attributes.clear();
    page.calls = [];
    // 10 <button> in the page, 20 <input> in a shadow root, 30 <a> inside an
    // iframe, 41 a text node inside 40.
    page.root = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      children: [
        element(10),
        element(15, { shadowRoots: [{ nodeId: 16, backendNodeId: 16, nodeType: 11, children: [element(20)] }] }),
        element(25, { contentDocument: { nodeId: 26, backendNodeId: 26, nodeType: 9, children: [element(30)] } }),
        element(40, { children: [{ nodeId: 41, backendNodeId: 41, nodeType: 3 }] })
      ]
    };
    page.ax = [
      { nodeId: "a", backendDOMNodeId: 10, role: { value: "button" }, name: { value: "Save" } },
      { nodeId: "b", backendDOMNodeId: 20, role: { value: "textbox" }, name: { value: "Search" } },
      { nodeId: "c", backendDOMNodeId: 30, role: { value: "link" }, name: { value: "Help" } },
      { nodeId: "d", backendDOMNodeId: 41, role: { value: "statictext" }, name: { value: "Total 4" } }
    ];
  });

  it("reuses refs the page view already gave and numbers new ones after them", async () => {
    page.attributes.set(10, "e7"); // stamped earlier by observe_page
    const snapshot = await captureAxSnapshot(1);
    expect(snapshot.elements.map((item) => [item.element_id, item.backend_node_id])).toEqual([
      ["@e7", 10],
      ["@e8", 20],
      ["@e9", 30],
      ["@e10", 40]
    ]);
    // Refs are written onto the page so observe_page and DOM actions see them.
    expect(page.attributes.get(20)).toBe("e8");
    expect(page.attributes.get(40)).toBe("e10");
  });

  it("resolves a ref from observe_page, including inside shadow roots and iframes", async () => {
    page.attributes.set(20, "e3");
    page.attributes.set(30, "e4");
    await expect(backendNodeForRef(5, "@e3")).resolves.toBe(20);
    await expect(backendNodeForRef(5, "@e4")).resolves.toBe(30);
  });

  it("fails loudly when a ref's element has left the page", async () => {
    await captureAxSnapshot(2);
    page.attributes.delete(10); // the page re-rendered; @e1 is gone
    await expect(backendNodeForRef(2, "@e1")).rejects.toThrow("not on the page any more");
    await expect(backendNodeForRef(2, "@e999")).rejects.toThrow("Unknown or stale element ref");
  });

  it("looks up the accessible name for approval checks on any ref", async () => {
    page.attributes.set(10, "e5");
    await expect(accessibleNameForRef(3, "@e5")).resolves.toBe("Delete account");
  });
});
