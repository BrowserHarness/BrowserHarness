// Runs a task sent from a chat app, in the Space it was queued in.
import { saveTaskHistoryEntry } from "./history";
import { CHAT_APP_NAMES, type RemoteTaskRequest } from "./remote-queue";
import { runUnattendedTask, type ScheduledRunOutcome } from "./scheduled-run";
import { pinSpace } from "./spaces";

/**
 * Runs a queued task in its own Space: pinned for the whole run, so every
 * read (notes, instructions, past conversations, Skills) and write (past
 * tasks, learned Skills, history) stays there.
 */
export async function runRemoteTask(
  request: RemoteTaskRequest & { space_id: string },
  log: (line: string) => void = () => undefined
): Promise<ScheduledRunOutcome> {
  pinSpace(request.space_id);
  const source = CHAT_APP_NAMES[request.from] || "your phone";
  const outcome = await runUnattendedTask(request.text, `From ${source}`, log);
  await saveTaskHistoryEntry({ task: `From ${source}: ${request.text}`, result: outcome.message, url: outcome.url, session_id: outcome.session_id }, request.space_id).catch(
    () => undefined
  );
  return outcome;
}
