// Learning runs a page twice and checks the result live; a Site Command can
// load the site's own page. Those answer well after an ordinary command's
// limit, and an answer that comes after it would be dropped.
const LONG_SITE_SKILL_ACTIONS = new Set(["learn_api", "repair", "verify", "run", "refine"]);

/** Whether a command may legitimately take minutes (a learn, a repair, a Site Command run). */
export function isLongCommand(command) {
  const args = command?.args && typeof command.args === "object" ? command.args : {};
  if (command?.action === "site_skill") return LONG_SITE_SKILL_ACTIONS.has(String(args.action || ""));
  if (command?.action === "site_commands") return typeof args.name === "string" && args.name.length > 0;
  return false;
}
