import { describe, expect, it, vi } from "vitest";
import {
  runBrowserTask,
  type BrowserDecisionContext,
  type BrowserEngineDependencies
} from "./browser-engine";
import type {
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";
import type { AgentDecision } from "./model-client";

function page(
  tabId: number,
  title: string,
  text: string,
  elements: PageObservation["elements"] = []
): PageObservation {
  return {
    tab_id: tabId,
    url: `https://example.com/${tabId}`,
    title,
    visible_text: text,
    elements,
    adapter: "generic-web"
  };
}

function harness(options: {
  observations: PageObservation[];
  decisions: AgentDecision[] | ((context: BrowserDecisionContext) => AgentDecision);
  toolResults?: Partial<Record<ToolName, ToolResult[]>>;
  approval?: boolean;
  cancelled?: () => boolean;
}) {
  const observations = [...options.observations];
  const toolResults = new Map<ToolName, ToolResult[]>();
  for (const [tool, results] of Object.entries(options.toolResults || {})) {
    toolResults.set(tool as ToolName, [...(results || [])]);
  }

  const contexts: BrowserDecisionContext[] = [];
  let decisionIndex = 0;

  const toolMock = vi.fn(async (name: ToolName) => {
    if (name === "observe_page") {
      const observation = observations.shift();
      return observation
        ? { ok: true, data: observation }
        : {
            ok: false,
            error: {
              code: "NO_OBSERVATION",
              message: "No observation queued"
            }
          };
    }

    const queued = toolResults.get(name);
    if (queued?.length) return queued.shift()!;

    return { ok: true, data: {} };
  });
  const tool = toolMock as BrowserEngineDependencies["tool"];

  const requestApproval = vi.fn(async () => options.approval ?? true);
  const waitWhilePaused = vi.fn(async () => undefined);
  const onFallback = vi.fn();

  const dependencies: BrowserEngineDependencies = {
    decide: async (context) => {
      contexts.push(context);
      const decision =
        typeof options.decisions === "function"
          ? options.decisions(context)
          : options.decisions[decisionIndex++];
      if (!decision) throw new Error("No decision queued");
      return { decision };
    },
    tool,
    approvalDescription: (observation, name, input) => {
      const id = input.element_id;
      const element =
        typeof id === "string"
          ? observation.elements.find(
              (candidate) => candidate.element_id === id
            )
          : undefined;
      return element?.requires_approval && name === "click"
        ? element.approval_reason || "Approval required"
        : null;
    },
    requestApproval,
    isCancelled: options.cancelled || (() => false),
    waitWhilePaused,
    withActivity: async (_label, operation) => operation(),
    onFallback
  };

  return {
    dependencies,
    tool,
    toolMock,
    contexts,
    requestApproval,
    waitWhilePaused,
    onFallback
  };
}

describe("Browser MVP engine scenarios", () => {
  it("completes a current-page read without mutation", async () => {
    const h = harness({
      observations: [page(1, "Article", "AI is changing software.")],
      decisions: [
        {
          kind: "final",
          message: "The page says AI is changing software."
        }
      ]
    });

    const result = await runBrowserTask("Summarize this page", h.dependencies);

    expect(result.status).toBe("completed");
    expect(result.message).toContain("AI");
    expect(h.toolMock.mock.calls.map(([tool]) => tool)).toEqual([
      "observe_page"
    ]);
  });

  it("navigates and verifies the destination before finishing", async () => {
    const h = harness({
      observations: [
        page(1, "Home", "Home"),
        page(1, "Pricing", "Starter $10")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "navigate",
          input: { url: "https://example.com/pricing" },
          note: "Opening pricing"
        },
        {
          kind: "final",
          message: "Opened pricing."
        }
      ],
      toolResults: {
        navigate: [
          {
            ok: true,
            data: {
              tab_id: 1,
              url: "https://example.com/pricing"
            }
          }
        ]
      }
    });

    const result = await runBrowserTask("Open pricing", h.dependencies);
    expect(result.status).toBe("completed");
    expect(h.toolMock.mock.calls.map(([tool]) => tool)).toContain("navigate");
    expect(h.contexts[1].observation.title).toBe("Pricing");
  });

  it("fills a form field without submitting", async () => {
    const inputElement = {
      element_id: "bc-name",
      tag: "input",
      role: "textbox",
      accessible_name: "Name",
      visible: true,
      disabled: false
    };
    const h = harness({
      observations: [
        page(1, "Form", "Name Submit", [inputElement]),
        page(1, "Form", "Alice Submit", [inputElement])
      ],
      decisions: [
        {
          kind: "tool",
          tool: "type",
          input: {
            element_id: "bc-name",
            text: "Alice"
          },
          note: "Filling name"
        },
        {
          kind: "final",
          message: "Filled the name field without submitting."
        }
      ]
    });

    await runBrowserTask(
      "Fill the name field but do not submit",
      h.dependencies
    );

    const tools = h.toolMock.mock.calls.map(([tool]) => tool);
    expect(tools).toContain("type");
    expect(tools).not.toContain("press_key");
    expect(tools).not.toContain("click");
  });

  it("retains evidence from multiple tabs for comparison", async () => {
    const h = harness({
      observations: [
        page(1, "Item A", "Price $10"),
        page(2, "Item B", "Price $20"),
        page(3, "Item C", "Price $15")
      ],
      decisions: (context) => {
        if (context.evidence.length === 1) {
          return {
            kind: "tool",
            tool: "open_tab",
            input: {
              url: "https://example.com/2",
              active: true
            },
            note: "Opening item B"
          };
        }
        if (context.evidence.length === 2) {
          return {
            kind: "tool",
            tool: "open_tab",
            input: {
              url: "https://example.com/3",
              active: true
            },
            note: "Opening item C"
          };
        }
        return {
          kind: "final",
          message: "Item A is cheapest at $10."
        };
      },
      toolResults: {
        open_tab: [
          { ok: true, data: { tab_id: 2 } },
          { ok: true, data: { tab_id: 3 } }
        ]
      }
    });

    const result = await runBrowserTask(
      "Compare the three items",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(result.evidence).toHaveLength(3);
    expect(h.contexts.at(-1)?.evidence.map((item) => item.title)).toEqual([
      "Item A",
      "Item B",
      "Item C"
    ]);
  });

  it("stops before a consequential action when approval is denied", async () => {
    const h = harness({
      observations: [
        page(1, "Checkout", "Place order", [
          {
            element_id: "bc-order",
            tag: "button",
            role: "button",
            accessible_name: "Place order",
            visible: true,
            disabled: false,
            requires_approval: true,
            approval_reason: "Place this order"
          }
        ])
      ],
      decisions: [
        {
          kind: "tool",
          tool: "click",
          input: { element_id: "bc-order" },
          note: "Placing order"
        }
      ],
      approval: false
    });

    const result = await runBrowserTask(
      "Place the order",
      h.dependencies
    );

    expect(result.status).toBe("approval-cancelled");
    expect(h.requestApproval).toHaveBeenCalledOnce();
    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "click")
    ).toHaveLength(0);
  });

  it("returns stopped when cancellation is already requested", async () => {
    const h = harness({
      observations: [page(1, "Page", "Content")],
      decisions: [],
      cancelled: () => true
    });

    const result = await runBrowserTask("Do work", h.dependencies);
    expect(result.status).toBe("stopped");
    expect(result.message).toBe("Stopped.");
  });

  it("re-observes after a stale element and recovers", async () => {
    let turn = 0;
    const h = harness({
      observations: [
        page(1, "Search", "Search", [
          {
            element_id: "bc-old",
            tag: "button",
            role: "button",
            accessible_name: "Search",
            visible: true,
            disabled: false
          }
        ]),
        page(1, "Search", "Search", [
          {
            element_id: "bc-new",
            tag: "button",
            role: "button",
            accessible_name: "Search",
            visible: true,
            disabled: false
          }
        ]),
        page(1, "Results", "Results")
      ],
      decisions: () => {
        turn += 1;
        if (turn === 1) {
          return {
            kind: "tool",
            tool: "click",
            input: { element_id: "bc-old" },
            note: "Searching"
          };
        }
        if (turn === 2) {
          return {
            kind: "tool",
            tool: "click",
            input: { element_id: "bc-new" },
            note: "Retrying search"
          };
        }
        return {
          kind: "final",
          message: "Search completed."
        };
      },
      toolResults: {
        click: [
          {
            ok: false,
            error: {
              code: "ELEMENT_NOT_FOUND",
              message: "Element not found"
            }
          },
          { ok: true, data: {} }
        ]
      }
    });

    const result = await runBrowserTask("Search", h.dependencies);
    expect(result.status).toBe("completed");
    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "observe_page")
    ).toHaveLength(3);
  });

  it("blocks a repeated-action loop before a third execution", async () => {
    const button = {
      element_id: "bc-loop",
      tag: "button",
      role: "button",
      accessible_name: "Retry",
      visible: true,
      disabled: false
    };
    const h = harness({
      observations: [
        page(1, "Loop", "Retry", [button]),
        page(1, "Loop", "Retry", [button]),
        page(1, "Loop", "Retry", [button])
      ],
      decisions: () => ({
        kind: "tool",
        tool: "click",
        input: { element_id: "bc-loop" },
        note: "Retrying"
      })
    });

    await expect(
      runBrowserTask("Keep trying", h.dependencies)
    ).rejects.toThrow("repeated action loop");

    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "click")
    ).toHaveLength(2);
  });

  it("carries screenshot visual evidence into the next planning turn", async () => {
    const screenshot = "data:image/png;base64,ZmFrZQ==";
    let turn = 0;
    const h = harness({
      observations: [page(1, "Canvas", "")],
      decisions: (context) => {
        turn += 1;
        if (turn === 1) {
          expect(context.screenshotDataUrl).toBeUndefined();
          return {
            kind: "tool",
            tool: "screenshot",
            input: {},
            note: "Inspecting the page visually"
          };
        }
        expect(context.screenshotDataUrl).toBe(screenshot);
        return {
          kind: "final",
          message: "The screenshot shows the requested content."
        };
      },
      toolResults: {
        screenshot: [
          {
            ok: true,
            data: {
              tab_id: 1,
              data_url: screenshot
            }
          }
        ]
      }
    });

    const result = await runBrowserTask(
      "Describe this visual page",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "screenshot")
    ).toHaveLength(1);
  });

  it("fails clearly when the initial page cannot be observed", async () => {
    const tool = vi.fn(async () => ({
      ok: false,
      error: {
        code: "UNSUPPORTED_PAGE",
        message: "Protected browser page"
      }
    })) as BrowserEngineDependencies["tool"];

    const dependencies: BrowserEngineDependencies = {
      decide: async () => {
        throw new Error("should not decide");
      },
      tool,
      approvalDescription: () => null,
      requestApproval: async () => true,
      isCancelled: () => false,
      waitWhilePaused: async () => undefined,
      withActivity: async (_label, operation) => operation()
    };

    await expect(
      runBrowserTask("Summarize this page", dependencies)
    ).rejects.toThrow("Protected browser page");
  });
});
