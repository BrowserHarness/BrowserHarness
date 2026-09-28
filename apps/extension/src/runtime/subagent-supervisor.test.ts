import { describe, expect, it, vi } from "vitest";
import {
  MAX_PARALLEL_READ_ONLY_WORKERS,
  parseReadOnlySubagentTasks,
  runReadOnlySubagentBatch
} from "./subagent-supervisor";

describe("parallel read-only subagent supervisor", () => {
  it("accepts one task or at most two unique parallel tasks", () => {
    expect(
      parseReadOnlySubagentTasks({
        task: "Read source A",
        max_steps: 99
      })
    ).toEqual({
      ok: true,
      tasks: [
        {
          task: "Read source A",
          max_steps: 8
        }
      ]
    });

    expect(
      parseReadOnlySubagentTasks({
        tasks: ["A", "B"]
      })
    ).toMatchObject({
      ok: true,
      tasks: [
        { task: "A" },
        { task: "B" }
      ]
    });

    expect(
      parseReadOnlySubagentTasks({
        tasks: ["A", "B", "C"]
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: "SUBAGENT_TASK_LIMIT"
      }
    });
    expect(MAX_PARALLEL_READ_ONLY_WORKERS).toBe(2);
  });

  it("launches two workers concurrently and merges in input order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;

    const launch = vi.fn(
      async (
        spec: { task: string },
        index: number
      ) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return {
          status: "completed" as const,
          message: `result:${spec.task}`,
          steps: 1,
          session_id: `worker-${index}`,
          sources: [
            {
              url: `https://example.com/${index}`,
              title: spec.task
            }
          ],
          tools_used: ["read_page"]
        };
      }
    );

    const pending = runReadOnlySubagentBatch(
      [
        { task: "A", max_steps: 4 },
        { task: "B", max_steps: 4 }
      ],
      launch
    );

    await Promise.resolve();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);

    release();
    const result = await pending;

    expect(result.workers.map((worker) => worker.task)).toEqual([
      "A",
      "B"
    ]);
    expect(result.completed_count).toBe(2);
    expect(result.sources).toEqual([
      {
        worker_index: 0,
        session_id: "worker-0",
        task: "A",
        url: "https://example.com/0",
        title: "A"
      },
      {
        worker_index: 1,
        session_id: "worker-1",
        task: "B",
        url: "https://example.com/1",
        title: "B"
      }
    ]);
  });

  it("retains a successful sibling when another worker fails", async () => {
    const result = await runReadOnlySubagentBatch(
      [
        { task: "good", max_steps: 4 },
        { task: "bad", max_steps: 4 }
      ],
      async (spec, index) => {
        if (spec.task === "bad") {
          throw new Error("source unavailable");
        }
        return {
          status: "completed",
          message: "evidence",
          steps: 2,
          session_id: `worker-${index}`,
          sources: [
            {
              url: "https://good.example",
              title: "Good"
            }
          ],
          tools_used: ["read_page"]
        };
      }
    );

    expect(result.completed_count).toBe(1);
    expect(result.non_completed_count).toBe(1);
    expect(result.workers[0].finding.status).toBe(
      "completed"
    );
    expect(result.workers[1].finding).toMatchObject({
      status: "failed",
      message: "source unavailable"
    });
    expect(result.sources).toHaveLength(1);
  });
});
