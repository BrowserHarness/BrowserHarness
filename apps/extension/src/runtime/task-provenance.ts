// Who found what during a task, which sources they used, who checked it and
// what the check concluded (Memory v2 Phase 8).
//
// Three different things come out of delegated work, and they are kept apart:
//   - a source observation: a page or tool a worker opened ("observed");
//   - a worker finding: a model's reading of those sources ("derived");
//   - a verifier verdict: a second model's judgment of a finding
//     ("derived_verification").
// None of them is the person's own word, and none of them ever becomes an
// About you fact, a preference, an instruction or a decision. They are task
// evidence, kept in the task's Space only.
//
// Everything here is bounded and cleaned before it is kept: no secret-looking
// text, no credential-bearing URL parameters, no hidden reasoning, no page
// dumps.
import { checkSensitive } from "./memory-write/sensitivity";
import type {
  BrowserSessionDagEvidence,
  BrowserSessionDagNodeEvidence,
  BrowserSessionDelegationWorkerEvidence
} from "./session-evidence";
import { MAX_TASK_DAG_NODES } from "./task-dag";
import type { TaskEpisodeDagNode, TaskEpisodeDagRun } from "./task-memory";

/** Per worker or node, as the runner already caps them. */
export const MAX_PROVENANCE_SOURCES = 6;
export const MAX_PROVENANCE_TOOLS = 20;
const MAX_TASK = 1000;
const MAX_TITLE = 240;
const MAX_URL = 500;
/** A short summary of a worker's conclusion, never its whole answer. */
export const MAX_FINDING = 280;

export type WorkerStatus = BrowserSessionDelegationWorkerEvidence["status"];
export type DagNodeStatus = BrowserSessionDagNodeEvidence["status"];
export type Verdict = NonNullable<BrowserSessionDagNodeEvidence["verdict"]>;

const WORKER_STATUSES = new Set<WorkerStatus>(["completed", "stopped", "approval-cancelled", "failed"]);
const NODE_STATUSES = new Set<DagNodeStatus>(["completed", "failed", "blocked", "cancelled"]);
const VERDICTS = new Set<Verdict>(["supported", "contradicted", "insufficient"]);

/** URL parameters that carry credentials or one-time secrets. */
const SECRET_PARAM =
  /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|auth|authorization|code|state|nonce|key|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|pass|otp|sig|signature|session|session[_-]?id|sessionid|sid|jwt|ticket|credential|x-amz-[\w-]+|x-goog-[\w-]+|awsaccesskeyid)$/i;

/**
 * A source URL that is safe to keep: no user name or password in it, no
 * token, code, key, signature or session parameter, no fragment carrying
 * values, and no data:, blob: or javascript: URLs. "" when nothing safe is left.
 */
export function safeSourceUrl(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "";
  }
  if (!/^(?:https?|file|chrome|about):$/.test(url.protocol)) return "";
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  for (const [name, value] of [...url.searchParams.entries()]) {
    if (SECRET_PARAM.test(name) || !checkSensitive(`${name.replace(/[_-]+/g, " ")} is ${value}`).allowed || !checkSensitive(value).allowed) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (url.hash.includes("=")) {
    url.hash = "";
    changed = true;
  }
  return (changed ? url.toString() : raw.trim()).slice(0, MAX_URL);
}

function squash(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** URLs inside free text, cleaned the same way as source URLs. */
function withSafeUrls(text: string): string {
  return text.replace(/\b(?:https?|data|blob|javascript):[^\s)"'<>\]]+/gi, (match) => safeSourceUrl(match) || "(link removed)");
}

/** What stands in for a part of a durable record that looked like a secret. */
export const SECRET_LEFT_OUT = "(left out: it looked like a secret)";

/**
 * Text kept in durable task memory or history (a task, an answer, a title):
 * hidden reasoning removed, links cleaned, and each line or sentence that
 * looks like a secret replaced by a neutral note. If the whole still reads as
 * secret-bearing, all of it is replaced. Ordinary words like "Password",
 * "Order #123456" or "Product ID B0C12345" stay.
 */
export function redactSecrets(text: unknown, max = MAX_TASK): string {
  if (typeof text !== "string") return "";
  const cleaned = withSafeUrls(text.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, " ")).trim();
  const redacted = cleaned
    .split(/(\n+|(?<=[.!?])\s+)/)
    .map((piece) => (!piece.trim() || /^\s+$/.test(piece) || checkSensitive(piece).allowed ? piece : SECRET_LEFT_OUT))
    .join("")
    .slice(0, max);
  return checkSensitive(redacted).allowed ? redacted : SECRET_LEFT_OUT;
}

/** A worker or node task as kept: bounded, links cleaned, and left out if it holds a secret. */
export function safeTask(task: string): string {
  const text = withSafeUrls(squash(task)).slice(0, MAX_TASK);
  return checkSensitive(text).allowed ? text : "(left out: it looked like it held a secret)";
}

/** A page title as kept: bounded, and empty if it holds a secret. */
export function safeTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  const text = squash(title).slice(0, MAX_TITLE);
  return checkSensitive(text).allowed ? text : "";
}

/**
 * A short summary of what a worker concluded, or nothing. It is a model's
 * reading of its sources, kept only when it is short, plain and safe: the
 * verdict line, markdown and hidden reasoning are removed, links are cleaned,
 * and anything that looks like a secret or encoded data drops it entirely.
 */
export function findingSummary(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const text = withSafeUrls(
    squash(message)
      .replace(/\bverdict\s*[:=]\s*(?:supported|contradicted|insufficient)\b[.:;,-]*/gi, " ")
      .replace(/[*_`#>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
  if (!text || /[A-Za-z0-9+/=_-]{80,}/.test(text)) return undefined;
  if (!checkSensitive(text).allowed) return undefined;
  if (text.length <= MAX_FINDING) return text;
  const cut = text.slice(0, MAX_FINDING - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX_FINDING / 2))}…`;
}

/** Sources as kept: cleaned, one per URL, at most six. */
export function safeSources(raw: unknown): Array<{ url: string; title: string }> {
  if (!Array.isArray(raw)) return [];
  const kept = new Map<string, string>();
  for (const source of raw) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const item = source as { url?: unknown; title?: unknown };
    const url = typeof item.url === "string" ? safeSourceUrl(item.url) : "";
    if (!url || kept.has(url)) continue;
    kept.set(url, safeTitle(item.title));
    if (kept.size >= MAX_PROVENANCE_SOURCES) break;
  }
  return [...kept].map(([url, title]) => ({ url, title }));
}

export function safeTools(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((item): item is string => typeof item === "string" && /^[a-z_]{1,40}$/.test(item)))].slice(0, MAX_PROVENANCE_TOOLS)
    : [];
}

export function workerStatus(value: unknown): WorkerStatus | undefined {
  return WORKER_STATUSES.has(value as WorkerStatus) ? (value as WorkerStatus) : undefined;
}

/** A failed launch has a placeholder session id; it names no real worker session. */
function realSession(value: unknown): string | undefined {
  return typeof value === "string" && value && !/^(?:dag|worker)-failed-/.test(value) ? value : undefined;
}

/**
 * The Task DAG result of an `agent` call, as session evidence: every node's
 * real end state, edges, sessions, sources and verdicts. Nothing missing is
 * filled in: a node that never ran has no session, sources or verdict, and a
 * verdict exists only for a verify node that completed. DAG workers are
 * always read-only, whatever the result claims.
 */
export function dagEvidenceFromResult(data: unknown): BrowserSessionDagEvidence | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const result = data as { nodes?: unknown; cancelled?: unknown };
  if (!Array.isArray(result.nodes)) return undefined;
  const cancelled = result.cancelled === true;
  const nodes: BrowserSessionDagNodeEvidence[] = [];
  const ids = new Set<string>();
  for (const raw of result.nodes.slice(0, MAX_TASK_DAG_NODES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id.trim().slice(0, 80) : "";
    const type = node.type === "verify" ? "verify" : node.type === "research" ? "research" : null;
    if (!id || !type || typeof node.task !== "string" || ids.has(id)) continue;
    // A node still pending or running when the run ended was cut short by cancelling; otherwise its state is unknown.
    const status = NODE_STATUSES.has(node.status as DagNodeStatus)
      ? (node.status as DagNodeStatus)
      : cancelled && (node.status === "pending" || node.status === "running")
        ? "cancelled"
        : null;
    if (!status) continue;
    ids.add(id);
    const finding = node.finding && typeof node.finding === "object" && !Array.isArray(node.finding) ? (node.finding as Record<string, unknown>) : undefined;
    const session = realSession(node.child_session_id) ?? realSession(finding?.session_id);
    const ran = Boolean(session) && Boolean(finding);
    const dependencies = Array.isArray(node.dependencies)
      ? [...new Set(node.dependencies.filter((dep): dep is string => typeof dep === "string" && dep !== id))]
      : [];
    const verdict =
      type === "verify" && status === "completed"
        ? VERDICTS.has(node.verdict as Verdict)
          ? (node.verdict as Verdict)
          : "insufficient"
        : undefined;
    const summary = status === "completed" ? findingSummary(finding?.message) : undefined;
    nodes.push({
      node_id: id,
      type,
      task: safeTask(node.task),
      status,
      ...(ran && workerStatus(finding?.status) ? { worker_status: workerStatus(finding?.status) } : {}),
      ...(session ? { child_session_id: session } : {}),
      depends_on: dependencies,
      ...(status === "blocked" && typeof node.blocked_by === "string" ? { blocked_by: node.blocked_by } : {}),
      sources: ran ? safeSources(finding?.sources) : [],
      tools_used: ran ? safeTools(finding?.tools_used) : [],
      ...(verdict ? { verdict } : {}),
      ...(summary ? { finding: summary } : {})
    });
  }
  if (!nodes.length) return undefined;
  // Edges only to nodes that are kept.
  for (const node of nodes) {
    node.depends_on = node.depends_on.filter((dep) => ids.has(dep));
    if (node.blocked_by && !ids.has(node.blocked_by)) delete node.blocked_by;
  }
  const count = (status: DagNodeStatus) => nodes.filter((node) => node.status === status).length;
  return {
    nodes,
    completed_count: count("completed"),
    failed_count: count("failed"),
    blocked_count: count("blocked"),
    cancelled_count: count("cancelled"),
    cancelled
  };
}

/** Plain words for a verdict, as said back to a model. */
export function verdictWords(verdict: Verdict | undefined, status: DagNodeStatus): string {
  if (status !== "completed") return status === "blocked" ? "not checked (the check was blocked)" : status === "cancelled" ? "not checked (cancelled)" : "not checked (the check failed)";
  if (verdict === "contradicted") return "CONTRADICTED when checked: treat it as wrong, not as a fact";
  if (verdict === "supported") return "supported by the sources checked then (true at that time; may have changed)";
  return "could not be confirmed when checked (inconclusive)";
}

/** The words of a past DAG that a request can match: node tasks and findings. */
export function dagRecallText(runs: TaskEpisodeDagRun[] | undefined): string {
  return (runs ?? []).flatMap((run) => run.nodes.map((node) => `${node.task} ${node.finding ?? ""}`)).join(" ");
}

function host(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

function clipped(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * A few plain lines on what a past Task DAG checked and concluded, for a
 * recalled episode. A claim is never shown without its verdict: a
 * contradicted one says so, an inconclusive one says it is uncertain, a
 * supported one says it was true at that time. Claims nobody checked say
 * that too. Bounded to `max` lines.
 */
export function verificationSummary(runs: TaskEpisodeDagRun[] | undefined, max = 3): string[] {
  const lines: string[] = [];
  for (const run of runs ?? []) {
    const byId = new Map(run.nodes.map((node) => [node.node_id, node]));
    for (const verifier of run.nodes.filter((node) => node.type === "verify")) {
      if (lines.length >= max) return lines;
      const checked = verifier.depends_on.map((id) => byId.get(id)).filter((node): node is TaskEpisodeDagNode => Boolean(node));
      const claims = checked.map((node) => `“${clipped(node.finding ?? node.task, 120)}”`).join(" and ");
      const sources = [...new Set([...checked.flatMap((node) => node.sources), ...verifier.sources].map((source) => host(source.url)))].slice(0, 3);
      lines.push(
        `Checked ${claims || `“${clipped(verifier.task, 120)}”`}: ${verdictWords(verifier.verdict, verifier.status)}${sources.length ? ` (sources then: ${sources.join(", ")})` : ""}`
      );
    }
    for (const node of run.nodes) {
      if (lines.length >= max) return lines;
      if (node.type !== "research" || node.status !== "completed" || node.checked_by?.length) continue;
      lines.push(`Not checked by a verifier: “${clipped(node.finding ?? node.task, 120)}”`);
    }
  }
  return lines;
}

/** True when a request asks whether something was checked, true or backed by sources. */
export const ASKS_ABOUT_VERIFICATION =
  /\b(verif\w*|check(ed|s)?|confirm\w*|contradict\w*|true|correct|accurate|right|wrong|sources?|evidence|proof|trust\w*|reliable|claims?|inconclusive)\b/i;
