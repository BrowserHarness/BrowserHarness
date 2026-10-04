import type {
  ReadOnlySubagentFinding
} from "./subagent-runner";

export const MAX_TASK_DAG_NODES = 4;
export const MAX_CONCURRENT_DAG_WORKERS = 2;
export const MAX_DAG_NODE_STEPS = 8;

export type TaskDagNodeType = "research" | "verify";

export type TaskDagNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type VerifierVerdict =
  | "supported"
  | "contradicted"
  | "insufficient";

export interface TaskDagNodeSpec {
  id: string;
  task: string;
  type: TaskDagNodeType;
  dependencies: string[];
  step_budget: number;
}

export interface TaskDagProvenance {
  node_id: string;
  type: TaskDagNodeType;
  session_id: string;
  sources: Array<{ url: string; title: string }>;
  /** Node ids this finding was derived from or checked against. */
  depends_on: string[];
}

export interface TaskDagNode extends TaskDagNodeSpec {
  status: TaskDagNodeStatus;
  child_session_id?: string;
  finding?: ReadOnlySubagentFinding;
  verdict?: VerifierVerdict;
  provenance?: TaskDagProvenance;
  blocked_by?: string;
}

export interface TaskDagError {
  code: string;
  message: string;
}

export type TaskDagParseResult =
  | { ok: true; nodes: TaskDagNodeSpec[] }
  | { ok: false; error: TaskDagError };

function fail(
  code: string,
  message: string
): { ok: false; error: TaskDagError } {
  return { ok: false, error: { code, message } };
}

function boundedSteps(value: unknown): number {
  const parsed = Math.round(
    Number(value ?? MAX_DAG_NODE_STEPS)
  );
  return Math.min(
    Math.max(
      Number.isFinite(parsed)
        ? parsed
        : MAX_DAG_NODE_STEPS,
      1
    ),
    MAX_DAG_NODE_STEPS
  );
}

export function parseTaskDag(
  input: unknown
): TaskDagParseResult {
  if (!Array.isArray(input) || input.length === 0) {
    return fail(
      "DAG_NODES_REQUIRED",
      "A task DAG needs a non-empty nodes array"
    );
  }
  if (input.length > MAX_TASK_DAG_NODES) {
    return fail(
      "DAG_NODE_LIMIT",
      `A task DAG allows at most ${MAX_TASK_DAG_NODES} nodes`
    );
  }

  const nodes: TaskDagNodeSpec[] = [];
  const ids = new Set<string>();

  for (const raw of input) {
    const item = (raw || {}) as Record<string, unknown>;
    const id =
      typeof item.id === "string" ? item.id.trim() : "";
    const task =
      typeof item.task === "string"
        ? item.task.trim()
        : "";
    if (!id || !task) {
      return fail(
        "DAG_NODE_INVALID",
        "Every node needs a non-empty id and task"
      );
    }
    if (ids.has(id)) {
      return fail(
        "DAG_NODE_DUPLICATE",
        `Duplicate node id: ${id}`
      );
    }
    ids.add(id);
    const type = item.type ?? "research";
    if (type !== "research" && type !== "verify") {
      return fail(
        "DAG_NODE_TYPE",
        `Node ${id} type must be research or verify`
      );
    }
    const deps = Array.isArray(item.dependencies)
      ? item.dependencies
      : [];
    if (deps.some((dep) => typeof dep !== "string")) {
      return fail(
        "DAG_NODE_INVALID",
        `Node ${id} dependencies must be node ids`
      );
    }
    nodes.push({
      id,
      task,
      type,
      dependencies: [...new Set(deps as string[])],
      step_budget: boundedSteps(item.step_budget)
    });
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (dep === node.id) {
        return fail(
          "DAG_CYCLE",
          `Node ${node.id} depends on itself`
        );
      }
      if (!ids.has(dep)) {
        return fail(
          "DAG_UNKNOWN_DEPENDENCY",
          `Node ${node.id} depends on unknown node ${dep}`
        );
      }
    }
    if (
      node.type === "verify" &&
      node.dependencies.length === 0
    ) {
      return fail(
        "DAG_VERIFIER_NEEDS_CLAIM",
        `Verifier node ${node.id} must depend on the node whose claim it checks`
      );
    }
  }

  if (hasCycle(nodes)) {
    return fail(
      "DAG_CYCLE",
      "Task DAG dependencies contain a cycle"
    );
  }

  return { ok: true, nodes };
}

function hasCycle(nodes: TaskDagNodeSpec[]): boolean {
  const remaining = new Map(
    nodes.map((node) => [
      node.id,
      new Set(node.dependencies)
    ])
  );
  let progressed = true;
  while (remaining.size && progressed) {
    progressed = false;
    for (const [id, deps] of [...remaining]) {
      if (deps.size === 0) {
        remaining.delete(id);
        for (const other of remaining.values()) {
          other.delete(id);
        }
        progressed = true;
      }
    }
  }
  return remaining.size > 0;
}

export function createTaskDagState(
  specs: TaskDagNodeSpec[]
): TaskDagNode[] {
  return specs.map((spec) => ({
    ...spec,
    status: "pending" as const
  }));
}

/** Marks pending nodes blocked when a prerequisite did not complete. Pure. */
export function propagateBlocked(
  nodes: TaskDagNode[]
): TaskDagNode[] {
  const next = nodes.map((node) => ({ ...node }));
  const byId = new Map(next.map((n) => [n.id, n]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of next) {
      if (node.status !== "pending") continue;
      const bad = node.dependencies.find((dep) => {
        const status = byId.get(dep)?.status;
        return (
          status === "failed" ||
          status === "blocked" ||
          status === "cancelled"
        );
      });
      if (bad) {
        node.status = "blocked";
        node.blocked_by = bad;
        changed = true;
      }
    }
  }
  return next;
}

/** Deterministic: ready nodes in original order, capped by free worker slots. */
export function selectReadyNodes(
  nodes: TaskDagNode[],
  maxConcurrent = MAX_CONCURRENT_DAG_WORKERS
): TaskDagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const running = nodes.filter(
    (n) => n.status === "running"
  ).length;
  const slots = Math.max(maxConcurrent - running, 0);
  return nodes
    .filter(
      (node) =>
        node.status === "pending" &&
        node.dependencies.every(
          (dep) => byId.get(dep)?.status === "completed"
        )
    )
    .slice(0, slots);
}

const VERDICT_PATTERN =
  /verdict\s*[:=]\s*(supported|contradicted|insufficient)/i;

/** Verifier output must state a verdict; anything else is insufficient. */
export function parseVerifierVerdict(
  message: string
): VerifierVerdict {
  const match = VERDICT_PATTERN.exec(message || "");
  return match
    ? (match[1].toLowerCase() as VerifierVerdict)
    : "insufficient";
}

export interface TaskDagLaunchContext {
  node: TaskDagNode;
  /** Completed prerequisite nodes, in dependency order. */
  prerequisites: TaskDagNode[];
  signal?: AbortSignal;
}

export type TaskDagLauncher = (
  context: TaskDagLaunchContext
) => Promise<ReadOnlySubagentFinding>;

export interface TaskDagResult {
  nodes: TaskDagNode[];
  completed_count: number;
  failed_count: number;
  blocked_count: number;
  cancelled_count: number;
  cancelled: boolean;
}

function failedFinding(
  node: TaskDagNode,
  reason: unknown
): ReadOnlySubagentFinding {
  return {
    status: "failed",
    message:
      reason instanceof Error
        ? reason.message
        : String(reason || "Worker failed."),
    steps: 0,
    session_id: `dag-failed-${node.id}`,
    sources: [],
    tools_used: []
  };
}

export async function runTaskDag(
  specs: TaskDagNodeSpec[],
  launch: TaskDagLauncher,
  signal?: AbortSignal,
  maxConcurrent = MAX_CONCURRENT_DAG_WORKERS
): Promise<TaskDagResult> {
  let nodes = createTaskDagState(specs);
  const inFlight = new Map<string, Promise<void>>();
  const concurrency = Math.min(
    Math.max(maxConcurrent, 1),
    MAX_CONCURRENT_DAG_WORKERS
  );

  const settle = (
    id: string,
    finding: ReadOnlySubagentFinding
  ) => {
    nodes = nodes.map((node) => {
      if (node.id !== id) return node;
      const completed = finding.status === "completed";
      const updated: TaskDagNode = {
        ...node,
        status: completed ? "completed" : "failed",
        child_session_id: finding.session_id,
        finding
      };
      if (completed) {
        updated.provenance = {
          node_id: node.id,
          type: node.type,
          session_id: finding.session_id,
          sources: finding.sources,
          depends_on: node.dependencies
        };
        if (node.type === "verify") {
          updated.verdict = parseVerifierVerdict(
            finding.message
          );
        }
      }
      return updated;
    });
  };

  const start = (node: TaskDagNode) => {
    const prerequisites = node.dependencies.map(
      (dep) => nodes.find((n) => n.id === dep)!
    );
    nodes = nodes.map((n) =>
      n.id === node.id
        ? { ...n, status: "running" as const }
        : n
    );
    const running = nodes.find((n) => n.id === node.id)!;
    const promise = (async () => {
      try {
        const finding = await launch({
          node: running,
          prerequisites,
          signal
        });
        settle(node.id, finding);
      } catch (error) {
        settle(node.id, failedFinding(node, error));
      } finally {
        inFlight.delete(node.id);
      }
    })();
    inFlight.set(node.id, promise);
  };

  while (true) {
    if (signal?.aborted) break;
    nodes = propagateBlocked(nodes);
    for (const node of selectReadyNodes(
      nodes,
      concurrency
    )) {
      start(node);
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight.values());
  }

  const cancelled = Boolean(signal?.aborted);
  if (cancelled) {
    // Children observe the same signal; wait for them to settle.
    await Promise.allSettled([...inFlight.values()]);
    nodes = nodes.map((node) =>
      node.status === "pending"
        ? { ...node, status: "cancelled" as const }
        : node
    );
  }
  nodes = propagateBlocked(nodes);

  const count = (status: TaskDagNodeStatus) =>
    nodes.filter((n) => n.status === status).length;
  return {
    nodes,
    completed_count: count("completed"),
    failed_count: count("failed"),
    blocked_count: count("blocked"),
    cancelled_count: count("cancelled"),
    cancelled
  };
}

/** Worker prompt for a node; verifier nodes get the claims to check and the verdict contract. */
export function buildDagWorkerTask(
  node: TaskDagNodeSpec,
  prerequisites: TaskDagNode[]
): string {
  if (node.type !== "verify") {
    return prerequisites.length
      ? `${node.task}\n\nContext from completed prerequisite nodes:\n${describePrerequisites(prerequisites)}`
      : node.task;
  }
  return [
    "You are an independent read-only VERIFIER. Do not trust the claims below; check them against primary sources you open yourself.",
    `Verification task: ${node.task}`,
    "Claims under review:",
    describePrerequisites(prerequisites),
    "Finish with one line exactly of the form `VERDICT: supported`, `VERDICT: contradicted` or `VERDICT: insufficient`, followed by the evidence (URLs) behind it."
  ].join("\n");
}

function describePrerequisites(
  prerequisites: TaskDagNode[]
): string {
  return prerequisites
    .map((item) => {
      const sources = (item.finding?.sources || [])
        .map((source) => source.url)
        .join(", ");
      return `- [${item.id}] ${item.finding?.message || ""}${sources ? ` (sources: ${sources})` : ""}`;
    })
    .join("\n");
}
