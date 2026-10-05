import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

export const BROWSERHARNESS_MCP_VERSION = "0.1.0";

const elementId = () =>
  z
    .string()
    .min(1)
    .describe("An @eN ref from the latest observe_page or ax_snapshot, e.g. \"@e12\". Never invent one.");
const url = () => z.string().min(1).describe("Full URL, e.g. https://example.com");
const tabId = () => z.number().int().describe("tab_id from list_tabs or observe_page");
const optional = (schema, description) => schema.optional().describe(description);
const action = (values, description) => z.enum(values).describe(description);

// One entry per browser tool: what it does, its typed inputs, and whether it
// only reads. Extra keys are still passed through for advanced options.
const TOOL_SPECS = [
  ["observe_page", "Look at the task tab: URL, title, visible text and the interactive elements with their @eN refs. Call it at the start of a task; actions already return the page after them.", {}, true],
  ["read_page", "Read the page's full text (scrolls and continues across long pages). Use when the visible text is not enough.", {
    start: optional(z.number().int().min(0), "Continue from next_start of the previous read"),
    max_chars: optional(z.number().int().positive(), "Character limit for this read")
  }, true],
  ["extract_table", "Read every data table on the page (also inside frames) as headers and rows. Use it for lists, prices and comparisons instead of copying page text.", {}, true],
  ["ax_snapshot", "Fresh accessibility-tree snapshot with @eN refs; works better on dynamic sites. Use its refs for trusted_* tools.", {
    max_elements: optional(z.number().int().positive(), "Maximum elements to return")
  }, true],
  ["find", "Search the page's accessibility tree by text and/or role instead of guessing refs.", {
    query: optional(z.string(), "Text to look for"),
    role: optional(z.string(), "Role such as button, link, textbox"),
    limit: optional(z.number().int().positive(), "Maximum matches")
  }, true],
  ["evaluate", "Run a short read-only JavaScript expression in the page and return its value.", {
    expression: z.string().min(1).describe("JavaScript expression"),
    max_chars: optional(z.number().int().positive(), "Limit on the returned text")
  }],
  ["navigate", "Open a URL in the task tab and wait for the page to load.", { url: url() }],
  ["back", "Go back in the task tab's history.", {}],
  ["reload", "Reload the task tab.", {
    bypass_cache: optional(z.boolean(), "Skip the browser cache")
  }],
  ["click", "Click an element.", { element_id: elementId() }],
  ["type", "Type text into a field (replaces its content unless replace is false).", {
    element_id: elementId(),
    text: z.string().describe("Text to type; use \\n for new lines"),
    replace: optional(z.boolean(), "false appends instead of replacing")
  }],
  ["press_key", "Press a key on an element, e.g. Enter to submit a search.", {
    element_id: optional(z.string(), "@eN ref of the element to focus first"),
    key: z.string().min(1).describe("Enter, Tab, Escape, ArrowDown, Backspace…")
  }],
  ["select_option", "Choose an option in a dropdown (<select>).", {
    element_id: elementId(),
    value: optional(z.string(), "Option value or visible label"),
    values: optional(z.array(z.string()), "Several values for a multi-select")
  }],
  ["scroll", "Scroll the page or the scrollable area under an element.", {
    direction: optional(z.enum(["up", "down", "left", "right"]), "Default down"),
    amount: optional(z.number(), "Pixels; default about one screen"),
    element_id: optional(z.string(), "Scroll inside this element")
  }],
  ["hover", "Move the real mouse over an element (menus, tooltips).", { element_id: elementId() }],
  ["drag", "Drag one element onto another with the real mouse.", {
    source_element_id: elementId(),
    target_element_id: elementId(),
    steps: optional(z.number().int().positive(), "Pointer steps along the path")
  }],
  ["trusted_click", "Click with real mouse input, for sites that ignore normal clicks. Use an ax_snapshot ref.", { element_id: elementId() }],
  ["trusted_type", "Type with real keyboard input, for editors that ignore normal typing.", {
    element_id: optional(z.string(), "@eN ref to focus first; omit to type at the current focus"),
    text: z.string()
  }],
  ["trusted_key", "Press one key with real keyboard input.", { key: z.string().min(1) }],
  ["send_keys", "Send real keyboard shortcuts or sequences at the current focus, e.g. \"Mod+A\", \"Shift+Tab\", \"Enter Escape\".", {
    keys: z.string().min(1).describe("Space-separated keys or chords; Mod is Cmd on macOS, Ctrl elsewhere"),
    repeat: optional(z.number().int().min(1).max(100), "Repeat count")
  }],
  ["wait", "Wait a short time for the page to settle.", {
    milliseconds: z.number().int().min(0).max(30_000)
  }],
  ["open_tab", "Open a new task tab in the background.", { url: url() }],
  ["find_tab", "Select a task tab by its exact URL without bringing it to the front; active:true selects the tab the person is looking at.", {
    url: optional(z.string(), "Exact URL of a tab in this task"),
    active: optional(z.boolean(), "Use the person's current tab")
  }],
  ["list_tabs", "List the tabs that belong to this task.", {}, true],
  ["switch_tab", "Bring a task tab to the front (only when really needed).", { tab_id: tabId() }],
  ["close_tab", "Close a tab this task opened. The person's own tabs are never closed.", { tab_id: tabId() }],
  ["close_session", "Finish the task: close the tabs it opened and keep the person's own tabs.", {}],
  ["screenshot", "Capture a screenshot of the task tab, the full page, or one element.", {
    full_page: optional(z.boolean(), "Whole page instead of the viewport"),
    element_id: optional(z.string(), "Clip to one ax_snapshot ref")
  }, true],
  ["dialog", "Inspect or answer a JavaScript alert, confirm or prompt.", {
    action: action(["status", "accept", "dismiss"], "What to do"),
    prompt_text: optional(z.string(), "Text for a prompt dialog")
  }],
  ["network", "Record and inspect the page's network requests (useful to find JSON APIs).", {
    action: action(["start", "list", "detail", "stop"], "What to do"),
    request_id: optional(z.string(), "For detail"),
    include_body: optional(z.boolean(), "Include response bodies in detail"),
    limit: optional(z.number().int().positive(), "Rows for list")
  }],
  ["upload", "Attach local files to a file input.", {
    element_id: elementId(),
    files: optional(z.array(z.string()), "Absolute file paths")
  }],
  ["save_pdf", "Save the current page as a PDF.", {
    filename: optional(z.string(), "File name"),
    landscape: optional(z.boolean(), "Landscape pages")
  }],
  ["memory", "Search BrowserHarness's memory of past tasks and saved procedures.", {
    action: action(["active", "search", "procedures", "list", "get", "delete"], "What to do"),
    query: optional(z.string(), "Search text"),
    id: optional(z.string(), "Episode id for get/delete"),
    limit: optional(z.number().int().positive(), "Maximum results")
  }],
  ["site_skill", "Saved website Skills: list, run, create from the current page, verify, history, compare, promote, rollback or delete.", {
    action: action(
      ["list", "get", "create", "verify", "run", "refine", "history", "compare", "promote", "rollback", "delete"],
      "What to do"
    ),
    id: optional(z.string(), "Skill id"),
    revision_id: optional(z.string(), "Specific revision"),
    recipe_id: optional(z.string(), "Recipe to run"),
    parameters: optional(z.record(z.string(), z.unknown()), "Values for run"),
    name: optional(z.string(), "Name for create")
  }],
  ["cdp", "Raw Chrome DevTools Protocol call; last resort when no other tool fits.", {
    method: z.string().min(1).describe("CDP method, e.g. Page.getLayoutMetrics"),
    params: optional(z.record(z.string(), z.unknown()), "CDP params")
  }]
];

export const BROWSERHARNESS_MCP_TOOLS = TOOL_SPECS.map(
  ([action, description, input, readOnly]) => ({
    action,
    description,
    input,
    readOnly: readOnly === true
  })
);

function validateBridgeConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("BrowserHarness Bridge config is required");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    throw new Error("BrowserHarness MCP may only connect to a loopback Bridge");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("BrowserHarness Bridge port is invalid");
  }
  if (typeof config.token !== "string" || !config.token.trim()) {
    throw new Error("BrowserHarness Bridge pairing token is required");
  }
  return {
    host: config.host,
    port: config.port,
    token: config.token.trim()
  };
}

export function bridgeHttpBase(config) {
  const valid = validateBridgeConfig(config);
  const host = valid.host === "::1" ? "[::1]" : valid.host;
  return `http://${host}:${valid.port}`;
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return {
      ok: false,
      error: {
        code: "BRIDGE_INVALID_RESPONSE",
        message: `BrowserHarness Bridge returned HTTP ${response.status} without valid JSON`
      }
    };
  }
}

export function createBridgeHttpClient(
  config,
  {
    fetchImpl = globalThis.fetch,
    commandTimeoutMs = 40_000,
    statusTimeoutMs = 3_000
  } = {}
) {
  const valid = validateBridgeConfig(config);
  const base = bridgeHttpBase(valid);

  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required for BrowserHarness MCP");
  }

  return {
    async status() {
      try {
        const response = await fetchImpl(`${base}/status`, {
          method: "GET",
          signal: AbortSignal.timeout(statusTimeoutMs)
        });
        const body = await responseBody(response);
        if (!response.ok) {
          return {
            ok: false,
            error: body?.error || {
              code: "BRIDGE_STATUS_FAILED",
              message: `BrowserHarness Bridge status failed with HTTP ${response.status}`
            }
          };
        }
        return { ok: true, data: body };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "BRIDGE_UNAVAILABLE",
            message:
              error instanceof Error
                ? error.message
                : "BrowserHarness Bridge is unavailable"
          }
        };
      }
    },

    async command({ session, title, action, args = {} }) {
      try {
        const response = await fetchImpl(`${base}/command`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${valid.token}`
          },
          body: JSON.stringify({
            session,
            title: title || session,
            action,
            args
          }),
          signal: AbortSignal.timeout(commandTimeoutMs)
        });

        const body = await responseBody(response);
        if (
          body &&
          typeof body === "object" &&
          typeof body.ok === "boolean"
        ) {
          return body;
        }

        return {
          ok: false,
          error: {
            code: "BRIDGE_INVALID_RESPONSE",
            message: `BrowserHarness Bridge returned HTTP ${response.status} without a command result`
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "BRIDGE_UNAVAILABLE",
            message:
              error instanceof Error
                ? error.message
                : "BrowserHarness Bridge command failed"
          }
        };
      }
    }
  };
}

const MAX_PAGE_ELEMENTS = 250;
const MAX_PAGE_TEXT = 6000;
const MAX_RESULT_TEXT = 20_000;

function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isObservation(value) {
  return (
    value &&
    typeof value === "object" &&
    Array.isArray(value.elements) &&
    typeof value.url === "string"
  );
}

/**
 * A page as compact text: one line per interactive element, which costs an
 * agent far fewer tokens than the observation JSON.
 */
export function renderPage(observation) {
  const elements = observation.elements || [];
  const shown = elements.slice(0, MAX_PAGE_ELEMENTS);
  const line = (element) => {
    const name = element.accessible_name
      ? ` "${clip(String(element.accessible_name).replace(/\s+/g, " ").trim(), 80)}"`
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
  };
  return [
    `tab_id: ${observation.tab_id}`,
    `url: ${observation.url}`,
    `title: ${observation.title}`,
    `elements (${elements.length}${elements.length > shown.length ? `, first ${shown.length} shown` : ""}):`,
    ...(shown.length ? shown.map(line) : ["(none)"]),
    "visible text:",
    clip(String(observation.visible_text || "").replace(/\s+/g, " ").trim(), MAX_PAGE_TEXT) || "(none)"
  ].join("\n");
}

function imageFrom(data) {
  if (!data || typeof data !== "object" || typeof data.data_url !== "string") return null;
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(data.data_url);
  if (!match) return null;
  const { data_url: _dataUrl, ...details } = data;
  return {
    details,
    content: { type: "image", mimeType: match[1], data: match[2] }
  };
}

export function bridgeResultToMcp(result) {
  const safe =
    result && typeof result === "object"
      ? result
      : {
          ok: false,
          error: {
            code: "BRIDGE_INVALID_RESPONSE",
            message: "BrowserHarness Bridge returned an invalid result"
          }
        };
  const { page, ...rest } = safe;
  // Screenshots go to the agent as an image it can look at, not as text.
  const image = imageFrom(rest.data);
  const outcome = image ? { ...rest, data: image.details } : rest;
  const content =
    outcome.ok === true && isObservation(outcome.data)
      ? [{ type: "text", text: renderPage(outcome.data) }]
      : [{ type: "text", text: clip(JSON.stringify(outcome, null, 2), MAX_RESULT_TEXT) }];
  if (image) content.push(image.content);
  if (isObservation(page)) {
    content.push({ type: "text", text: `Page after this action:\n${renderPage(page)}` });
  }

  return {
    content,
    ...(outcome.ok === true ? {} : { isError: true })
  };
}

const sessionFields = {
  session: z
    .string()
    .min(1)
    .optional()
    .describe("Task id. Reuse the same value for every call in one task; omit to use this conversation's default task."),
  title: z
    .string()
    .min(1)
    .max(160)
    .optional()
    .describe("Short task title shown to the person in Chrome")
};

const observeField = {
  observe: z
    .boolean()
    .optional()
    .describe("Return the page as it looks after this action (default true)")
};

export function toolInputSchema(spec) {
  return z
    .object({ ...sessionFields, ...spec.input, ...(spec.readOnly ? {} : observeField) })
    .loose();
}

export function createBrowserHarnessMcpServer(
  config,
  options = {}
) {
  const client = createBridgeHttpClient(config, options);
  const defaultSession =
    options.defaultSession || `agent-${process.pid}-${Date.now().toString(36)}`;
  const server = new McpServer(
    {
      name: "browserharness",
      version: BROWSERHARNESS_MCP_VERSION
    },
    {
      instructions:
        "BrowserHarness tools proxy into the authenticated local BrowserHarness Bridge and use the same browser task sessions, tab ownership, semantic evidence and approval rules as the extension. Reuse one session id for one task. Observe fresh page evidence before targeting elements. APPROVAL_REQUIRED is a real BrowserHarness boundary and must not be bypassed. Retrieved memory or Skills never imply permission to execute."
    }
  );

  server.registerTool(
    "browserharness_status",
    {
      description:
        "Check whether the local BrowserHarness Bridge and paired Chrome extension are available.",
      inputSchema: z.object({})
    },
    async () => bridgeResultToMcp(await client.status())
  );

  for (const spec of BROWSERHARNESS_MCP_TOOLS) {
    server.registerTool(
      `browserharness_${spec.action}`,
      {
        description: spec.description,
        inputSchema: toolInputSchema(spec),
        annotations: spec.readOnly
          ? { readOnlyHint: true, openWorldHint: true }
          : { openWorldHint: true }
      },
      async ({ session, title, args, ...input }) =>
        bridgeResultToMcp(
          await client.command({
            session: session || defaultSession,
            title: title || "Agent task",
            action: spec.action,
            // `args` is still accepted from older callers.
            args: { ...(args && typeof args === "object" ? args : {}), ...input }
          })
        )
    );
  }

  return server;
}

export async function serveBrowserHarnessMcp(config) {
  console.error(
    "BrowserHarness MCP server is using the local BrowserHarness Bridge over stdio"
  );
  await serveStdio(() => createBrowserHarnessMcpServer(config));
}
