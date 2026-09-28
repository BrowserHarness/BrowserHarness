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

export async function captureAxSnapshot(
  tabId: number,
  maxElements = 300
): Promise<AxSnapshot> {
  const result = await cdpCommand<{ nodes?: AxNode[] }>(
    tabId,
    "Accessibility.getFullAXTree"
  );

  const refs = new Map<string, number>();
  const elements: AxSemanticElement[] = [];
  let counter = 0;

  for (const node of result.nodes || []) {
    if (node.ignored || !node.backendDOMNodeId) continue;

    const role = valueOf(node.role).toLowerCase();
    const name = valueOf(node.name).trim();
    const value = valueOf(node.value).trim();
    const description = valueOf(node.description).trim();

    if (!INTERACTIVE_ROLES.has(role) && !name) continue;
    if (elements.length >= maxElements) break;

    const ref = `@e${++counter}`;
    refs.set(ref, node.backendDOMNodeId);
    elements.push({
      element_id: ref,
      backend_node_id: node.backendDOMNodeId,
      role: role || "generic",
      name,
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      disabled: propertyBoolean(node, "disabled"),
      focused: propertyBoolean(node, "focused")
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
          element.focused ? "focused" : ""
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

export function backendNodeForRef(
  tabId: number,
  ref: string
): number {
  const backendNodeId = refsByTab.get(tabId)?.get(ref);
  if (!backendNodeId) {
    throw new Error(
      `Unknown or stale accessibility ref: ${ref}. Capture a fresh ax_snapshot.`
    );
  }
  return backendNodeId;
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
