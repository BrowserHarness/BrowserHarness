import {
  MAX_ACTING_HELPER_STEPS,
  type ReadOnlySubagentFinding
} from "./subagent-runner";

/** Helpers per delegation, read-only or acting. */
export const MAX_PARALLEL_READ_ONLY_WORKERS = 4;
/** How many of them run at the same moment; the rest wait their turn. */
export const MAX_CONCURRENT_HELPERS = 3;
export const MAX_READ_ONLY_WORKER_STEPS = 8;

export interface ReadOnlySubagentTaskSpec {
  task: string;
  max_steps: number;
  /** True for a helper that clicks and types in its own tab. */
  act?: boolean;
}

export interface ReadOnlySubagentBatchWorker {
  index: number;
  task: string;
  finding: ReadOnlySubagentFinding;
}

export interface ReadOnlySubagentBatchResult {
  worker_count: number;
  completed_count: number;
  non_completed_count: number;
  workers: ReadOnlySubagentBatchWorker[];
  sources: Array<{
    worker_index: number;
    session_id: string;
    task: string;
    url: string;
    title: string;
  }>;
}

function boundedSteps(value: unknown, cap = MAX_READ_ONLY_WORKER_STEPS): number {
  const parsed = Math.round(Number(value ?? cap));
  return Math.min(
    Math.max(
      Number.isFinite(parsed)
        ? parsed
        : cap,
      1
    ),
    cap
  );
}

export function parseReadOnlySubagentTasks(
  input: Record<string, unknown>
):
  | { ok: true; tasks: ReadOnlySubagentTaskSpec[] }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    } {
  const act = input.act === true;
  const commonSteps = boundedSteps(input.max_steps, act ? MAX_ACTING_HELPER_STEPS : MAX_READ_ONLY_WORKER_STEPS);
  const rawTasks = Array.isArray(input.tasks)
    ? input.tasks
    : typeof input.task === "string"
      ? [input.task]
      : [];

  if (rawTasks.length === 0) {
    return {
      ok: false,
      error: {
        code: "SUBAGENT_TASK_REQUIRED",
        message:
          "agent requires task or a tasks array"
      }
    };
  }

  if (
    rawTasks.length >
    MAX_PARALLEL_READ_ONLY_WORKERS
  ) {
    return {
      ok: false,
      error: {
        code: "SUBAGENT_TASK_LIMIT",
        message:
          `BrowserHarness allows at most ${MAX_PARALLEL_READ_ONLY_WORKERS} helpers per delegation.`
      }
    };
  }

  const tasks: ReadOnlySubagentTaskSpec[] = [];
  const seen = new Set<string>();

  for (const raw of rawTasks) {
    if (typeof raw !== "string" || !raw.trim()) {
      return {
        ok: false,
        error: {
          code: "SUBAGENT_TASK_INVALID",
          message:
            "Every delegated task must be a non-empty string"
        }
      };
    }

    const task = raw.trim();
    if (seen.has(task)) continue;
    seen.add(task);
    tasks.push(
      act
        ? { task, max_steps: commonSteps, act: true }
        : { task, max_steps: commonSteps }
    );
  }

  if (!tasks.length) {
    return {
      ok: false,
      error: {
        code: "SUBAGENT_TASK_REQUIRED",
        message:
          "agent requires at least one unique task"
      }
    };
  }

  return { ok: true, tasks };
}

function failedFinding(
  task: string,
  index: number,
  reason: unknown
): ReadOnlySubagentFinding {
  return {
    status: "failed",
    message:
      reason instanceof Error
        ? reason.message
        : String(reason || "Worker failed."),
    steps: 0,
    session_id: `worker-failed-${index + 1}`,
    sources: [],
    tools_used: []
  };
}

export async function runReadOnlySubagentBatch(
  tasks: ReadOnlySubagentTaskSpec[],
  launch: (
    spec: ReadOnlySubagentTaskSpec,
    index: number
  ) => Promise<ReadOnlySubagentFinding>,
  signal?: AbortSignal
): Promise<ReadOnlySubagentBatchResult> {
  if (
    tasks.length < 1 ||
    tasks.length > MAX_PARALLEL_READ_ONLY_WORKERS
  ) {
    throw new Error(
      `SUBAGENT_TASK_LIMIT: expected 1-${MAX_PARALLEL_READ_ONLY_WORKERS} tasks`
    );
  }

  // At most MAX_CONCURRENT_HELPERS run at once; each next one starts as one finishes.
  const settled: PromiseSettledResult<ReadOnlySubagentFinding>[] = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const index = next++;
      if (signal?.aborted) {
        settled[index] = { status: "rejected", reason: new DOMException("Subagent delegation aborted", "AbortError") };
        continue;
      }
      try {
        settled[index] = { status: "fulfilled", value: await launch(tasks[index], index) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_HELPERS, tasks.length) }, lane)
  );

  if (signal?.aborted) {
    const rejected = settled.find(
      (item) => item.status === "rejected"
    );
    throw (
      rejected && rejected.status === "rejected"
        ? rejected.reason
        : new DOMException(
            "Subagent delegation aborted",
            "AbortError"
          )
    );
  }

  const workers = settled.map(
    (item, index): ReadOnlySubagentBatchWorker => ({
      index,
      task: tasks[index].task,
      finding:
        item.status === "fulfilled"
          ? item.value
          : failedFinding(
              tasks[index].task,
              index,
              item.reason
            )
    })
  );

  const sources = workers.flatMap((worker) =>
    worker.finding.sources.map((source) => ({
      worker_index: worker.index,
      session_id: worker.finding.session_id,
      task: worker.task,
      url: source.url,
      title: source.title
    }))
  );

  return {
    worker_count: workers.length,
    completed_count: workers.filter(
      (worker) =>
        worker.finding.status === "completed"
    ).length,
    non_completed_count: workers.filter(
      (worker) =>
        worker.finding.status !== "completed"
    ).length,
    workers,
    sources
  };
}
