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
import type { BrowserWorkingMemory } from "./working-memory";
import type { TaskEpisodeMemory } from "./task-memory";
import type { ProceduralSearchHit } from "./procedural-memory";

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

  const toolMock = vi.fn(
    async (
      name: ToolName,
      _input: Record<string, unknown> = {},
      _execution?: { approvalGranted?: boolean }
    ) => {
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
    }
  );
  const tool = toolMock as BrowserEngineDependencies["tool"];

  const requestApproval = vi.fn(async () => options.approval ?? true);
  const waitWhilePaused = vi.fn(async () => undefined);
  const onFallback = vi.fn();
  const persistWorkingMemory = vi.fn(
    async (_memory: BrowserWorkingMemory) => undefined
  );

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
    persistWorkingMemory,
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
    onFallback,
    persistWorkingMemory
  };
}

describe("Browser MVP engine scenarios", () => {
  it("supplies bounded recalled episodes as historical planning evidence", async () => {
    const h = harness({
      observations: [page(1, "Checkout", "Continue")],
      decisions: [
        {
          kind: "final",
          message: "Done."
        }
      ]
    });

    const recalled: TaskEpisodeMemory = {
      schema_version: 1,
      id: "episode:prior",
      kind: "task_episode",
      recorded_at: "2026-09-28T08:00:00.000Z",
      session_id: "prior-session",
      title: "Prior checkout",
      task: "Finish checkout",
      status: "completed",
      start: {
        tab_id: 4,
        url: "https://example.com/checkout",
        title: "Checkout"
      },
      action_count: 2,
      manual_handoff_count: 0,
      tools: ["site_skill"],
      targets: ["Continue"],
      sites: ["https://example.com"],
      skill_refs: [
        {
          id: "SK-SITE-CHECKOUT",
          action: "run",
          revision_id: "SK-SITE-CHECKOUT:r1"
        }
      ],
      sensitive_payloads_removed: true
    };

    h.dependencies.recallMemory = vi.fn(
      async () => [recalled]
    );

    await runBrowserTask(
      "Finish checkout",
      h.dependencies
    );

    expect(h.contexts[0].recalled_memory).toEqual([
      recalled
    ]);
  });

  it("supplies recalled procedures with exact revision provenance", async () => {
    const h = harness({
      observations: [page(1, "Checkout", "Continue")],
      decisions: [
        {
          kind: "final",
          message: "Done."
        }
      ]
    });

    const recalled: ProceduralSearchHit = {
      procedure: {
        skill_id: "SK-SITE-CHECKOUT",
        revision_id: "SK-SITE-CHECKOUT:r3",
        active: true,
        latest: true,
        lifecycle: "active",
        name: "Checkout",
        slug: "checkout",
        origin: "https://example.com",
        entry_url: "https://example.com/checkout",
        captured_at: "2026-09-28T12:00:00.000Z",
        structural_verification: "passed",
        latest_execution: "passed",
        execution_runs: 3,
        execution_passed: 3,
        execution_failed: 0,
        execution_success_rate: 1,
        promotion_eligible: true,
        promotion_reasons: [],
        parameters: [],
        recipes: []
      },
      score: 0.02,
      semantic_rank: 1,
      semantic_similarity: 0.9,
      evidence_preference: 0.006,
      retrieval: ["semantic"]
    };

    h.dependencies.recallProcedures = vi.fn(
      async () => [recalled]
    );

    await runBrowserTask(
      "Finish checkout",
      h.dependencies
    );

    expect(h.contexts[0].recalled_procedures).toEqual([
      recalled
    ]);
  });

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

  it("runs a site search and verifies the results state", async () => {
    const searchElement = {
      element_id: "bc-search",
      tag: "input",
      role: "textbox",
      accessible_name: "Search",
      visible: true,
      disabled: false,
      enter_requires_approval: false
    };
    const h = harness({
      observations: [
        page(1, "Home", "Search", [searchElement]),
        page(1, "Home", "BrowserCrew", [searchElement]),
        page(1, "Results", "BrowserCrew result 1")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "type",
          input: {
            element_id: "bc-search",
            text: "BrowserCrew"
          },
          note: "Entering search term"
        },
        {
          kind: "tool",
          tool: "press_key",
          input: {
            element_id: "bc-search",
            key: "Enter"
          },
          note: "Running search"
        },
        {
          kind: "final",
          message: "Search results are visible."
        }
      ]
    });

    const result = await runBrowserTask(
      "Search this site for BrowserCrew",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(
      h.toolMock.mock.calls.map(([tool]) => tool)
    ).toEqual(
      expect.arrayContaining(["type", "press_key"])
    );
    expect(h.contexts.at(-1)?.observation.title).toBe("Results");
  });

  it("persists sanitized working memory as browser state changes", async () => {
    const inputElement = {
      element_id: "bc-email",
      tag: "input",
      role: "textbox",
      accessible_name: "Email",
      visible: true,
      disabled: false
    };
    const h = harness({
      observations: [
        page(1, "Form", "Email", [inputElement]),
        page(1, "Form", "Email entered", [inputElement])
      ],
      decisions: [
        {
          kind: "tool",
          tool: "type",
          input: {
            element_id: "bc-email",
            text: "private@example.com"
          },
          note: "Entering email"
        },
        {
          kind: "final",
          message: "Done."
        }
      ]
    });

    await runBrowserTask("Enter my email", h.dependencies);

    expect(h.persistWorkingMemory.mock.calls.length).toBeGreaterThanOrEqual(
      2
    );
    const latest =
      h.persistWorkingMemory.mock.calls.at(-1)?.[0];

    expect(latest).toMatchObject({
      status: "active",
      action_count: 1,
      recent_actions: [
        {
          ordinal: 1,
          tool: "type",
          target: "Email"
        }
      ]
    });
    expect(JSON.stringify(latest)).not.toContain(
      "private@example.com"
    );
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

  it("lists session tabs without forcing a page re-observation", async () => {
    const h = harness({
      observations: [page(1, "Item A", "Price $10")],
      decisions: [
        {
          kind: "tool",
          tool: "list_tabs",
          input: {},
          note: "Checking task tabs"
        },
        {
          kind: "final",
          message: "Task tabs checked."
        }
      ],
      toolResults: {
        list_tabs: [
          {
            ok: true,
            data: {
              session_id: "task-1",
              tabs: [
                {
                  tab_id: 1,
                  url: "https://example.com/1",
                  title: "Item A"
                }
              ]
            }
          }
        ]
      }
    });

    const result = await runBrowserTask(
      "Check my task tabs",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "observe_page")
    ).toHaveLength(1);
    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "list_tabs")
    ).toHaveLength(1);
  });

  it("re-observes after finding and selecting a session tab", async () => {
    const h = harness({
      observations: [
        page(1, "Item A", "Price $10"),
        page(2, "Item B", "Price $20")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "find_tab",
          input: { url: "https://example.com/2" },
          note: "Returning to item B"
        },
        {
          kind: "final",
          message: "Returned to item B."
        }
      ],
      toolResults: {
        find_tab: [
          {
            ok: true,
            data: {
              tab_id: 2,
              url: "https://example.com/2"
            }
          }
        ]
      }
    });

    const result = await runBrowserTask(
      "Return to item B",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(h.contexts.at(-1)?.observation.tab_id).toBe(2);
    expect(
      h.toolMock.mock.calls.filter(([tool]) => tool === "observe_page")
    ).toHaveLength(2);
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

  it("retries a runtime-discovered approval boundary with privileged proof", async () => {
    const h = harness({
      observations: [
        page(1, "Checkout", "Continue"),
        page(1, "Done", "Completed")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "trusted_click",
          input: { element_id: "@e1" },
          note: "Continuing"
        },
        {
          kind: "final",
          message: "Done."
        }
      ],
      toolResults: {
        trusted_click: [
          {
            ok: false,
            error: {
              code: "APPROVAL_REQUIRED",
              message: "Trusted click requires explicit approval"
            }
          },
          {
            ok: true,
            data: {}
          }
        ]
      }
    });

    const result = await runBrowserTask(
      "Continue checkout",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(h.requestApproval).toHaveBeenCalledWith(
      "Trusted click requires explicit approval"
    );

    const calls = h.toolMock.mock.calls.filter(
      ([tool]) => tool === "trusted_click"
    );
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).toBeUndefined();
    expect(calls[1][2]).toEqual({
      approvalGranted: true
    });
    expect(result.session_evidence.actions[0].approval).toMatchObject({
      required: true,
      approved: true,
      description: "Trusted click requires explicit approval"
    });
  });

  it("does not retry a runtime-discovered approval boundary when denied", async () => {
    const h = harness({
      observations: [page(1, "Checkout", "Continue")],
      decisions: [
        {
          kind: "tool",
          tool: "trusted_click",
          input: { element_id: "@e1" },
          note: "Continuing"
        }
      ],
      toolResults: {
        trusted_click: [
          {
            ok: false,
            error: {
              code: "APPROVAL_REQUIRED",
              message: "Trusted click requires explicit approval"
            }
          }
        ]
      },
      approval: false
    });

    const result = await runBrowserTask(
      "Continue checkout",
      h.dependencies
    );

    expect(result.status).toBe("approval-cancelled");
    expect(
      h.toolMock.mock.calls.filter(
        ([tool]) => tool === "trusted_click"
      )
    ).toHaveLength(1);
    expect(result.session_evidence.actions).toHaveLength(0);
  });

  it("honors the pause gate before requesting each model decision", async () => {
    let pauseGatePassed = false;
    const h = harness({
      observations: [page(1, "Page", "Content")],
      decisions: () => {
        expect(pauseGatePassed).toBe(true);
        return {
          kind: "final",
          message: "Done after pause gate."
        };
      }
    });

    h.dependencies.waitWhilePaused = vi.fn(async () => {
      pauseGatePassed = true;
    });

    const result = await runBrowserTask(
      "Do work after pause",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(h.dependencies.waitWhilePaused).toHaveBeenCalledOnce();
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
  it("emits structured evidence only for successful browser actions", async () => {
    const searchElement = {
      element_id: "bc-search",
      semantic_ref: "@e1",
      tag: "input",
      role: "textbox",
      accessible_name: "Search",
      visible: true,
      disabled: false
    };
    const h = harness({
      observations: [
        page(7, "Search", "Search", [searchElement]),
        page(7, "Results", "Keyboard results", [searchElement])
      ],
      decisions: [
        {
          kind: "tool",
          tool: "type",
          input: {
            element_id: "bc-search",
            text: "mechanical keyboard"
          },
          note: "Entering query"
        },
        {
          kind: "final",
          message: "Results are ready."
        }
      ]
    });
    h.dependencies.session = {
      id: "task-search-7",
      title: "Search products"
    };

    const result = await runBrowserTask(
      "Search for a mechanical keyboard",
      h.dependencies
    );

    expect(result.session_evidence).toMatchObject({
      version: 1,
      session_id: "task-search-7",
      title: "Search products",
      task: "Search for a mechanical keyboard",
      status: "completed",
      start: {
        tab_id: 7,
        url: "https://example.com/7",
        title: "Search"
      },
      boundary_action_id: "action-1"
    });
    expect(result.session_evidence.actions).toHaveLength(1);
    expect(result.session_evidence.actions[0]).toMatchObject({
      id: "action-1",
      ordinal: 1,
      tool: "type",
      input: {
        element_id: "bc-search",
        text: "mechanical keyboard"
      },
      target: {
        element_id: "bc-search",
        semantic_ref: "@e1",
        role: "textbox",
        accessible_name: "Search"
      },
      approval: {
        required: false,
        approved: true
      },
      after: {
        tab_id: 7,
        title: "Results"
      }
    });
  });

  it("redacts Site Skill run parameter values from session evidence", async () => {
    const h = harness({
      observations: [
        page(8, "Checkout", "Checkout"),
        page(8, "Done", "Thanks")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "site_skill",
          input: {
            action: "run",
            id: "SK-SITE-1",
            parameters: {
              email: "user@example.com",
              password: "top-secret"
            }
          },
          note: "Running saved Site Skill"
        },
        {
          kind: "final",
          message: "Done."
        }
      ],
      toolResults: {
        site_skill: [
          {
            ok: true,
            data: {
              candidate_id: "SK-SITE-1"
            }
          }
        ]
      }
    });

    h.dependencies.session = {
      id: "site-skill-task",
      title: "Run Site Skill"
    };

    const result = await runBrowserTask(
      "Run my checkout Skill",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(result.session_evidence.actions[0].input).toEqual({
      action: "run",
      id: "SK-SITE-1",
      parameters: {
        email: "<redacted>",
        password: "<redacted>"
      }
    });
    expect(
      JSON.stringify(result.session_evidence)
    ).not.toContain("top-secret");
    expect(
      JSON.stringify(result.session_evidence)
    ).not.toContain("user@example.com");
  });

  it("does not advance session evidence for stale failed attempts", async () => {
    let turn = 0;
    const oldButton = {
      element_id: "bc-old",
      tag: "button",
      role: "button",
      accessible_name: "Search",
      visible: true,
      disabled: false
    };
    const newButton = {
      ...oldButton,
      element_id: "bc-new",
      semantic_ref: "@e-new"
    };
    const h = harness({
      observations: [
        page(8, "Search", "Search", [oldButton]),
        page(8, "Search", "Search", [newButton]),
        page(8, "Results", "Results", [newButton])
      ],
      decisions: () => {
        turn += 1;
        if (turn === 1) {
          return {
            kind: "tool",
            tool: "click",
            input: { element_id: "bc-old" },
            note: "Trying stale target"
          };
        }
        if (turn === 2) {
          return {
            kind: "tool",
            tool: "click",
            input: { element_id: "bc-new" },
            note: "Clicking refreshed target"
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

    expect(result.session_evidence.actions).toHaveLength(1);
    expect(result.session_evidence.actions[0]).toMatchObject({
      id: "action-1",
      tool: "click",
      input: { element_id: "bc-new" }
    });
    expect(result.session_evidence.boundary_action_id).toBe(
      "action-1"
    );
  });

  it("resumes planning from fresh page state after a manual handoff", async () => {
    const h = harness({
      observations: [
        page(12, "Sign in", "Two-factor authentication required"),
        page(12, "Account", "Signed in")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "await_user_action",
          input: {
            reason: "Complete two-factor authentication on example.com."
          },
          note: "Waiting for authentication"
        },
        {
          kind: "final",
          message: "Signed in and ready."
        }
      ]
    });

    const requestUserAction = vi.fn(async () => ({
      status: "continue" as const,
      source: "user" as const
    }));
    h.dependencies.requestUserAction = requestUserAction;
    h.dependencies.session = {
      id: "task-handoff-12",
      title: "Sign in"
    };

    const result = await runBrowserTask(
      "Open my account after I sign in",
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(result.message).toBe("Signed in and ready.");
    expect(requestUserAction).toHaveBeenCalledWith(
      "Complete two-factor authentication on example.com.",
      expect.objectContaining({
        tab_id: 12,
        title: "Sign in"
      }),
      undefined
    );
    expect(h.contexts[1].observation).toMatchObject({
      tab_id: 12,
      title: "Account",
      visible_text: "Signed in"
    });
    expect(result.session_evidence.actions).toEqual([]);
    expect(
      result.session_evidence.boundary_action_id
    ).toBeUndefined();
    expect(result.session_evidence.manual_handoffs).toEqual([
      expect.objectContaining({
        id: "handoff-1",
        reason: "Complete two-factor authentication on example.com.",
        status: "continued",
        source: "user",
        before: {
          tab_id: 12,
          url: "https://example.com/12",
          title: "Sign in"
        },
        after: {
          tab_id: 12,
          url: "https://example.com/12",
          title: "Account"
        }
      })
    ]);
  });

  it("stops cleanly when the user cancels a manual handoff", async () => {
    const h = harness({
      observations: [
        page(13, "Verification", "Complete CAPTCHA")
      ],
      decisions: [
        {
          kind: "tool",
          tool: "await_user_action",
          input: {
            reason: "Complete the CAPTCHA on example.com."
          },
          note: "Waiting for verification"
        }
      ]
    });

    const requestUserAction = vi.fn(async () => ({
      status: "cancelled" as const,
      source: "user" as const
    }));
    h.dependencies.requestUserAction = requestUserAction;

    const result = await runBrowserTask(
      "Continue after verification",
      h.dependencies
    );

    expect(result.status).toBe("stopped");
    expect(result.message).toContain("manual step was cancelled");
    expect(result.session_evidence.actions).toEqual([]);
    expect(
      result.session_evidence.boundary_action_id
    ).toBeUndefined();
    expect(result.session_evidence.manual_handoffs).toEqual([
      expect.objectContaining({
        reason: "Complete the CAPTCHA on example.com.",
        status: "cancelled",
        source: "user",
        before: {
          tab_id: 13,
          url: "https://example.com/13",
          title: "Verification"
        }
      })
    ]);
    expect(
      h.toolMock.mock.calls.filter(
        ([tool]) => tool === "observe_page"
      )
    ).toHaveLength(1);
  });

  it("does not learn a consequential action when approval is denied", async () => {
    const h = harness({
      observations: [
        page(9, "Checkout", "Place order", [
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
    expect(result.session_evidence.actions).toEqual([]);
    expect(
      result.session_evidence.boundary_action_id
    ).toBeUndefined();
  });

});
