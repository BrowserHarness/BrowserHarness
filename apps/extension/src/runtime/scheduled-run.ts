// Runs one scheduled task with nobody watching: its own background tab,
// no questions (anything that needs approval stops and waits for the
// person), and a short result for history and the notification.
import { aboutMePrompt, loadAboutMe } from "./about-me";
import { autoApproves } from "./approval-mode";
import { approvalQuestionFor, extensionMessage, runAgentTask } from "./agent-task";
import { classifyTaskIntent } from "./intent";
import { directChatWithFallback } from "./model-router";
import { loadSkills, recordSkillRun, skillTask } from "./skills";
import { parseSlashCommand } from "./slash-commands";
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

export async function runScheduledTask(
  item: ScheduledTask,
  log: (line: string) => void = () => undefined
): Promise<ScheduledRunOutcome> {
  const primary = await loadActiveConnection();
  if (!primary || !hasCredentials(primary) || !primary.model) {
    return { status: "failed", message: "No AI model is connected. Open BrowserHarness and connect one." };
  }
  const fallback = await loadFallbackConnection();

  const command = parseSlashCommand(item.task, await loadSkills());
  if (command.kind === "builtin" || command.kind === "unknown") {
    return {
      status: "failed",
      message:
        command.kind === "unknown"
          ? `There's no Skill called /${command.name} any more.`
          : `/${command.name} can't run on a schedule.`
    };
  }
  const skill = command.kind === "skill" ? command.skill : null;
  const task = skill ? skillTask(skill, command.kind === "skill" ? command.args : "") : item.task;
  const aboutMe = aboutMePrompt(await loadAboutMe().catch(() => []));
  const preferences = await loadPreferences();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_LIMIT_MS);
  try {
    if (!skill && classifyTaskIntent(task) === "chat") {
      log("Asking the model");
      const routed = await directChatWithFallback(
        primary,
        fallback?.chatHealth.status === "healthy" ? fallback : null,
        task + aboutMe,
        controller.signal
      );
      return { status: "worked", message: routed.result };
    }

    const agentPrimary =
      primary.agentHealth.status !== "failed"
        ? primary
        : fallback?.agentHealth.status === "healthy"
          ? fallback
          : null;
    if (!agentPrimary) {
      return { status: "failed", message: `${primary.model} did not pass the browser-control check. Pick another model.` };
    }
    const agentFallback =
      agentPrimary.id === primary.id && fallback?.agentHealth.status === "healthy" ? fallback : null;

    const session = {
      id: crypto.randomUUID(),
      title: `Scheduled: ${item.task.length > 36 ? `${item.task.slice(0, 35)}…` : item.task}`
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

    let needsYou = "";
    const result = await runAgentTask(task + aboutMe, {
      agentPrimary,
      agentFallback,
      session,
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
    if (result.status === "completed") {
      if (skill) await recordSkillRun(skill.id, "worked").catch(() => null);
      return { status: "worked", message: result.message, url };
    }
    if (needsYou || result.status === "approval-cancelled") {
      return {
        status: "needs you",
        message: `Stopped before this step, which needs you: ${needsYou || "an approval"}. Open the task's tab to finish it.`,
        url
      };
    }
    if (skill) await recordSkillRun(skill.id, "failed", result.message).catch(() => null);
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
