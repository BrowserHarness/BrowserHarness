import type { InteractiveElement, PageObservation } from "./protocol";

/**
 * How much page and history the planner prompt may carry. Local models
 * (LM Studio, Ollama) often run with a 4k-8k token context window, so they get
 * a much smaller prompt than hosted models.
 */
export interface PromptBudget {
  maxElements: number;
  maxVisibleText: number;
  /** Cap for each recent trail entry (tool results can be huge). */
  maxTrailEntry: number;
  /** How many recent trail entries are shown in full. */
  recentTrail: number;
}

export const HOSTED_BUDGET: PromptBudget = {
  maxElements: 250,
  maxVisibleText: 6000,
  maxTrailEntry: 4000,
  recentTrail: 8
};

export const LOCAL_BUDGET: PromptBudget = {
  maxElements: 70,
  maxVisibleText: 1800,
  maxTrailEntry: 900,
  recentTrail: 4
};

export function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, Math.max(0, max - 1))}…`
    : text;
}

function elementLine(element: InteractiveElement): string {
  const name = element.accessible_name
    ? ` "${clip(element.accessible_name.replace(/\s+/g, " ").trim(), 80)}"`
    : "";
  const flags = [
    element.type ? `type=${element.type}` : "",
    element.disabled ? "disabled" : "",
    element.in_viewport === false ? "offscreen" : "",
    element.requires_approval ? "approval-required" : ""
  ]
    .filter(Boolean)
    .join(",");
  return `${element.element_id} ${element.role}${name} <${element.tag}>${flags ? ` [${flags}]` : ""}`;
}

/**
 * The page as the planner sees it: one line per interactive element (id, role,
 * name) instead of the element JSON plus a duplicate text snapshot.
 */
export function renderObservationForPrompt(
  observation: PageObservation,
  budget: PromptBudget = HOSTED_BUDGET
): string {
  const elements = observation.elements || [];
  const shown = elements.slice(0, budget.maxElements);
  const lines = [
    `tab_id: ${observation.tab_id}`,
    `url: ${observation.url}`,
    `title: ${observation.title}`,
    `adapter: ${observation.adapter || "generic-web"}`,
    `interactive elements (element_id role "name" <tag> [flags]), ${elements.length} total${elements.length > shown.length ? `, first ${shown.length} shown` : ""}:`,
    ...(shown.length ? shown.map(elementLine) : ["(none)"]),
    "visible text:",
    clip(observation.visible_text || "", budget.maxVisibleText) || "(none)"
  ];
  return lines.join("\n");
}

/**
 * Stand-in observation for pages BrowserHarness cannot read (the New Tab
 * page, chrome:// pages, the Web Store), so a task can still start there by
 * navigating somewhere else.
 */
export function unreadablePageObservation(
  reason: string,
  tabId = 0
): PageObservation {
  return {
    tab_id: tabId,
    url: "about:unreadable",
    title: "Page BrowserHarness cannot read",
    visible_text: `${reason} Use navigate or open_tab with a full https:// URL to continue.`,
    snapshot: "",
    elements: [],
    adapter: "generic-web"
  };
}
