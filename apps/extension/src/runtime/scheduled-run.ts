// Runs one scheduled task with nobody watching: its own background tab,
// no questions (anything that needs approval stops and waits for the
// person), and a short result for history and the notification.
import { contextFor, localMemorySource } from "./context";
import { agentRoute, chatRoute } from "./route";
import { localMemoryWriter } from "./memory-write/writer";
import { autoApproves } from "./approval-mode";
import { approvalQuestionFor, extensionMessage, runAgentTask } from "./agent-task";
import { directChatWithFallback } from "./model-router";
import { loadSkills, recordSkillRun, skillTask } from "./skills";
import { applyLearningPlan, planLearning } from "./skill-learning";
import { activeSpaceId } from "./spaces";
import { BUILT_IN_COMMANDS, parseSlashCommand } from "./slash-commands";
import type { ScheduledTask } from "./schedules";
import { loadPreferences } from "../settings/preferences";
import {
  hasCredentials,
  loadActiveConnection,
  loadFallbackConnection
} from "../settings/provider-store";

export interface ScheduledRunOutcome {
  status: "worked" | "failed" | "needs you";
  message: string;
  url?: string;
}

const RUN_LIMIT_MS = 10 * 60_000;

export function runScheduledTask(
  item: ScheduledTask,
  log: (line: string) => void = () => undefined
): Promise<ScheduledRunOutcome> {
  return runUnattendedTask(item.task, "Scheduled", log);
}

/** A task nobody is watching: from a schedule or from the person's phone. */
export async function runUnattendedTask(
  taskText: string,
  label: string,
  log: (line: string) => void = () => undefined
): Promise<ScheduledRunOutcome> {
  const primary = await loadActiveConnection();
  if (!primary || !hasCredentials(primary) || !primary.model) {
    return { status: "failed", message: "No AI model is connected. Open BrowserHarness and connect one." };
  }
  const fallback = await loadFallbackConnection();
  // Fixed once: a schedule's own Space (pinned by the runner page), or the
  // Space in use when a phone message arrived. Every read and write below uses it.
  const spaceId = await activeSpaceId();

  const skills = await loadSkills(spaceId);
  const command = parseSlashCommand(taskText, skills);
  if (command.kind === "builtin" || command.kind === "unknown") {
    return {
      status: "failed",
      message:
        command.kind === "unknown"
          ? `There's no Skill called /${command.name} any more.`
          : `/${command.name} only works in the side panel.`
    };
  }
  const skill = command.kind === "skill" ? command.skill : null;
  const task = skill ? skillTask(skill, command.kind === "skill" ? command.args : "") : taskText;
  const preferences = await loadPreferences();
  // What goes with the task: compiled for this Space and model, like a chat request.
  // One memory source and writer for the whole task: its context, the agent and its helpers.
  const memorySource = localMemorySource;
  const memoryWriter = localMemoryWriter;
  const { compiled, text: context } = await contextFor({
    request: taskText,
    spaceId,
    connection: primary,
    fallback,
    source: memorySource,
    skill,
    autoSkills: preferences.autoSkills,
    recall: !skill
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_LIMIT_MS);
  try {
    // A saved Skill like this task guides it, and the run teaches that Skill.
    const hinted = skill ? null : compiled.skill;
    if (compiled.intent === "chat") {
      log("Asking the model");
      const route = chatRoute(primary, fallback);
      const routed = await directChatWithFallback(
        route.primary,
        route.fallback,
        task + context,
        controller.signal
      );
      return { status: "worked", message: routed.result };
    }

    const { primary: agentPrimary, fallback: agentFallback } = agentRoute(primary, fallback);
    if (!agentPrimary) {
      return { status: "failed", message: `${primary.model} did not pass the browser-control check. Pick another model.` };
    }
    const session = {
      id: crypto.randomUUID(),
      title: `${label}: ${taskText.length > 36 ? `${taskText.slice(0, 35)}…` : taskText}`
    };
    // Its own background tab, so it never takes over the tab the person is using.
    const opened = await extensionMessage<{ tab_id: number }>({
      type: "BROWSER_TOOL",
      tool: "open_tab",
      input: skill?.start_url ? { url: skill.start_url } : {},
      session_id: session.id,
      session_title: session.title
    });
    if (!opened.ok) {
      return { status: "failed", message: opened.error?.message || "Couldn't open a tab for the task." };
    }

    if (hinted) log(`Following your Skill /${hinted.slug}`);

    let needsYou = "";
    const result = await runAgentTask(task, {
      context,
      agentPrimary,
      agentFallback,
      session,
      spaceId,
      memorySource,
      memoryWriter,
      signal: controller.signal,
      hooks: {
        addActivity: (text) => {
          log(text);
          return crypto.randomUUID();
        },
        finishActivity: () => undefined,
        isCancelled: () => controller.signal.aborted,
        isPaused: () => false,
        approvalQuestion: (observation, tool, input) =>
          approvalQuestionFor(preferences.approvalMode, observation, tool, input),
        requestApproval: async (description) => {
          if (autoApproves(preferences.approvalMode, description)) {
            log(`Approved automatically (automatic mode): ${description}`);
            return true;
          }
          needsYou = description;
          return false;
        },
        requestUserAction: async (reason) => {
          needsYou = reason;
          return { status: "cancelled", source: "user" };
        }
      }
    });

    const url = result.session_evidence.actions.at(-1)?.after?.url || result.session_evidence.start?.url;
    const learning = (status: "completed" | "stopped") =>
      applyLearningPlan(
        planLearning({
          task: taskText,
          status,
          message: result.message,
          evidence: result.session_evidence,
          used: skill ?? hinted,
          autoSkills: preferences.autoSkills
        }),
        BUILT_IN_COMMANDS.map((item) => item.name),
        spaceId
      ).catch(() => null);
    if (result.status === "completed") {
      const saved = await learning("completed");
      if (saved && !skill && !hinted) log(`Learned this as /${saved.slug}`);
      return { status: "worked", message: result.message, url };
    }
    if (needsYou || result.status === "approval-cancelled") {
      return {
        status: "needs you",
        message: `Stopped before this step, which needs you: ${needsYou || "an approval"}. Open the task's tab to finish it.`,
        url
      };
    }
    if (!controller.signal.aborted && result.status === "stopped") await learning("stopped");
    return {
      status: "failed",
      message: controller.signal.aborted ? "Stopped: the task ran for more than 10 minutes." : result.message,
      url
    };
  } catch (error) {
    if (skill) await recordSkillRun(skill.id, "failed").catch(() => null);
    return {
      status: "failed",
      message: controller.signal.aborted
        ? "Stopped: the task ran for more than 10 minutes."
        : error instanceof Error
          ? error.message
          : "The task hit an unexpected error."
    };
  } finally {
    clearTimeout(timer);
  }
}
