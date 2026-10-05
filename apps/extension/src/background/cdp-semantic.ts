import { cdpCommand } from "./cdp-manager";

interface AxValue {
  type?: string;
  value?: unknown;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: Array<{
    name: string;
    value?: AxValue;
  }>;
}

export interface AxSemanticElement {
  element_id: string;
  backend_node_id: number;
  role: string;
  name: string;
  value?: string;
  description?: string;
  disabled: boolean;
  focused: boolean;
  checked?: boolean | "mixed";
}

export interface AxSnapshot {
  text: string;
  elements: AxSemanticElement[];
}

export interface AxFindOptions {
  query?: string;
  role?: string;
  limit?: number;
}

interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  shadowRootType?: string;
}

/** The page attribute that holds an element's @eN ref (shared with the content script). */
export const REF_ATTRIBUTE = "data-browserharness-ref";

const refsByTab = new Map<number, Map<string, number>>();
const elementsByTab = new Map<number, Map<string, AxSemanticElement>>();

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "tab",
  "treeitem"
]);

function valueOf(value?: AxValue): string {
  const raw = value?.value;
  return raw === undefined || raw === null ? "" : String(raw);
}

function propertyBoolean(
  node: AxNode,
  name: string
): boolean {
  const property = node.properties?.find((item) => item.name === name);
  return Boolean(property?.value?.value);
}

function propertyChecked(
  node: AxNode
): boolean | "mixed" | undefined {
  const raw = node.properties?.find(
    (item) => item.name === "checked"
  )?.value?.value;

  if (raw === "mixed") return "mixed";
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return undefined;
}

interface DomIndex {
  /** backendNodeId → the element itself, or the parent element of a text node. */
  elementFor: Map<number, DomNode>;
  /** ref attribute value (eN) → backendNodeId. */
  byRef: Map<string, number>;
  highest: number;
}

function refOf(node: DomNode): string {
  const attributes = node.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === REF_ATTRIBUTE) return attributes[index + 1] || "";
  }
  return "";
}

/** One pass over the whole page, shadow roots and same-process iframes included. */
async function indexDom(tabId: number): Promise<DomIndex> {
  const { root } = await cdpCommand<{ root: DomNode }>(tabId, "DOM.getDocument", {
    depth: -1,
    pierce: true
  });
  const index: DomIndex = { elementFor: new Map(), byRef: new Map(), highest: 0 };
  const stack: Array<{ node: DomNode; parent: DomNode | null }> = [{ node: root, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (node.nodeType === 1) {
      index.elementFor.set(node.backendNodeId, node);
      const ref = refOf(node);
      if (ref) {
        index.byRef.set(ref, node.backendNodeId);
        const match = /^e(\d+)$/.exec(ref);
        if (match) index.highest = Math.max(index.highest, Number(match[1]));
      }
    } else if (node.nodeType === 3 && parent?.nodeType === 1) {
      index.elementFor.set(node.backendNodeId, parent);
    }
    const element = node.nodeType === 1 ? node : parent;
    for (const child of [
      ...(node.children || []),
      // Browser-owned shadow trees (inside <input>, <video>…) cannot carry refs.
      ...(node.shadowRoots || []).filter((shadow) => shadow.shadowRootType !== "user-agent"),
      ...(node.contentDocument ? [node.contentDocument] : [])
    ]) {
      stack.push({ node: child, parent: element });
    }
  }
  return index;
}

export async function captureAxSnapshot(
  tabId: number,
  maxElements = 300
): Promise<AxSnapshot> {
  const result = await cdpCommand<{ nodes?: AxNode[] }>(
    tabId,
    "Accessibility.getFullAXTree"
  );
  const dom = await indexDom(tabId);

  const refs = new Map<string, number>();
  const elements: AxSemanticElement[] = [];
  const seen = new Set<number>();
  let counter = dom.highest;

  for (const node of result.nodes || []) {
    if (node.ignored || !node.backendDOMNodeId) continue;

    const role = valueOf(node.role).toLowerCase();
    const name = valueOf(node.name).trim();
    const value = valueOf(node.value).trim();
    const description = valueOf(node.description).trim();

    if (!INTERACTIVE_ROLES.has(role) && !name) continue;
    if (elements.length >= maxElements) break;

    // Refs live on page elements (text nodes use their parent), so the
    // same @eN works for observe_page, ax_snapshot and every action tool.
    const target = dom.elementFor.get(node.backendDOMNodeId);
    if (!target || seen.has(target.backendNodeId)) continue;
    seen.add(target.backendNodeId);
    let attribute = refOf(target);
    if (!attribute) {
      attribute = `e${counter + 1}`;
      try {
        await cdpCommand(tabId, "DOM.setAttributeValue", {
          nodeId: target.nodeId,
          name: REF_ATTRIBUTE,
          value: attribute
        });
      } catch {
        continue;
      }
      counter += 1;
    }
    const ref = `@${attribute}`;
    refs.set(ref, target.backendNodeId);
    elements.push({
      element_id: ref,
      backend_node_id: target.backendNodeId,
      role: role || "generic",
      name,
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      disabled: propertyBoolean(node, "disabled"),
      focused: propertyBoolean(node, "focused"),
      ...(propertyChecked(node) !== undefined
        ? { checked: propertyChecked(node) }
        : {})
    });
  }

  refsByTab.set(tabId, refs);
  elementsByTab.set(
    tabId,
    new Map(elements.map((element) => [element.element_id, element]))
  );

  return {
    text: elements
      .map((element) => {
        const name = element.name ? ` "${element.name}"` : "";
        const value = element.value ? ` value="${element.value}"` : "";
        const flags = [
          element.disabled ? "disabled" : "",
          element.focused ? "focused" : "",
          element.checked === true
            ? "checked"
            : element.checked === false
              ? "unchecked"
              : element.checked === "mixed"
                ? "mixed"
                : ""
        ]
          .filter(Boolean)
          .join(",");
        return `${element.element_id} ${element.role}${name}${value}${flags ? ` [${flags}]` : ""}`;
      })
      .join("\n"),
    elements
  };
}

export function findAxElements(
  snapshot: AxSnapshot,
  options: AxFindOptions
): AxSemanticElement[] {
  const query = (options.query || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const role = (options.role || "").trim().toLowerCase();
  const limit = Math.min(
    Math.max(Math.round(Number(options.limit || 20)), 1),
    100
  );

  const queryTokens = query.split(" ").filter(Boolean);

  return snapshot.elements
    .map((element, index) => {
      const name = element.name.toLowerCase();
      const haystack = [
        element.role,
        element.name,
        element.value || "",
        element.description || ""
      ]
        .join(" ")
        .toLowerCase();

      if (role && element.role.toLowerCase() !== role) {
        return null;
      }

      if (
        queryTokens.length &&
        !queryTokens.every((token) => haystack.includes(token))
      ) {
        return null;
      }

      let score = 0;
      if (query && name === query) score += 100;
      else if (query && name.includes(query)) score += 60;
      score += queryTokens.length * 10;
      if (role) score += 20;

      return { element, score, index };
    })
    .filter(
      (
        item
      ): item is {
        element: AxSemanticElement;
        score: number;
        index: number;
      } => Boolean(item)
    )
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index
    )
    .slice(0, limit)
    .map((item) => item.element);
}

async function nodeStillHasRef(tabId: number, backendNodeId: number, ref: string): Promise<boolean> {
  try {
    const { node } = await cdpCommand<{ node: DomNode }>(tabId, "DOM.describeNode", {
      backendNodeId
    });
    return refOf(node) === ref.slice(1);
  } catch {
    return false;
  }
}

/**
 * The page element behind an @eN ref, from ax_snapshot or observe_page alike.
 * A ref whose element has left the page fails loudly instead of hitting
 * whatever element now sits there.
 */
export async function backendNodeForRef(
  tabId: number,
  ref: string
): Promise<number> {
  const remembered = refsByTab.get(tabId)?.get(ref);
  if (remembered && (await nodeStillHasRef(tabId, remembered, ref))) {
    return remembered;
  }
  const found = /^@e\d+$/.test(ref)
    ? (await indexDom(tabId)).byRef.get(ref.slice(1))
    : undefined;
  if (!found) {
    throw new Error(
      `Unknown or stale element ref: ${ref}. It is not on the page any more; observe the page again and use a current ref.`
    );
  }
  const refs = refsByTab.get(tabId) || new Map<string, number>();
  refs.set(ref, found);
  refsByTab.set(tabId, refs);
  return found;
}

/** The accessible name of a ref's element, for approval checks. */
export async function accessibleNameForRef(tabId: number, ref: string): Promise<string> {
  const known = elementsByTab.get(tabId)?.get(ref);
  if (known) return known.name;
  const backendNodeId = await backendNodeForRef(tabId, ref);
  const { nodes } = await cdpCommand<{ nodes?: AxNode[] }>(
    tabId,
    "Accessibility.getPartialAXTree",
    { backendNodeId, fetchRelatives: false }
  );
  return valueOf(nodes?.find((node) => !node.ignored)?.name).trim();
}

export function elementForAxRef(
  tabId: number,
  ref: string
): AxSemanticElement | null {
  return elementsByTab.get(tabId)?.get(ref) || null;
}

export function clearAxRefs(tabId: number): void {
  refsByTab.delete(tabId);
  elementsByTab.delete(tabId);
}
