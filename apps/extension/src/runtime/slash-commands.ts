// Slash commands typed in the chat box: built-ins plus one per saved Skill.
import type { UserSkill } from "./skills";
import type { SiteCommand } from "./site-commands";

export interface SlashCommandInfo {
  name: string;
  usage: string;
  description: string;
}

export const BUILT_IN_COMMANDS: SlashCommandInfo[] = [
  { name: "remember", usage: "/remember <fact>", description: "Save a fact about you, like “I live in Pune”" },
  { name: "forget", usage: "/forget <words>", description: "Delete saved facts that mention these words" },
  { name: "memory", usage: "/memory", description: "See and edit what BrowserHarness knows about you" },
  { name: "skills", usage: "/skills", description: "See, run, rename and share your Skills" },
  { name: "schedule", usage: "/schedule every weekday at 8am <task>", description: "Run a task on a schedule" },
  { name: "help", usage: "/help", description: "List every command" }
];

export type SlashCommand =
  | { kind: "none" }
  | { kind: "builtin"; name: string; args: string }
  | { kind: "skill"; skill: UserSkill; args: string }
  | { kind: "site"; command: SiteCommand; args: string }
  | { kind: "unknown"; name: string };

export function parseSlashCommand(
  text: string,
  skills: UserSkill[],
  siteCommands: SiteCommand[] = []
): SlashCommand {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { kind: "none" };
  const name = match[1].toLowerCase();
  const args = (match[2] || "").trim();
  if (BUILT_IN_COMMANDS.some((command) => command.name === name)) return { kind: "builtin", name, args };
  const skill = skills.find((item) => item.slug === name);
  if (skill) return { kind: "skill", skill, args };
  const site = siteCommands.find((item) => item.name === name);
  return site ? { kind: "site", command: site, args } : { kind: "unknown", name };
}

function siteUsage(command: SiteCommand): string {
  const main = command.parameters.find((parameter) => parameter.required) || command.parameters[0];
  return `/${command.name}${main ? ` <${main.name}>` : ""}`;
}

/** Commands matching what has been typed so far ("/" or "/rem"). */
export function slashSuggestions(
  text: string,
  skills: UserSkill[],
  siteCommands: SiteCommand[] = []
): SlashCommandInfo[] {
  const match = /^\/([a-z0-9-]*)$/i.exec(text);
  if (!match) return [];
  const typed = match[1].toLowerCase();
  const all = [
    ...BUILT_IN_COMMANDS,
    ...skills.map((skill) => ({
      name: skill.slug,
      usage: `/${skill.slug} [details]`,
      description: skill.name
    })),
    ...siteCommands.map((command) => ({
      name: command.name,
      usage: siteUsage(command),
      description: `${command.title} (${command.site})`
    }))
  ];
  return all.filter((command) => command.name.startsWith(typed)).slice(0, 8);
}

export function helpText(skills: UserSkill[], siteCommands: SiteCommand[] = []): string {
  const sites = siteCommands.length
    ? [
        "",
        "Website commands (learned from sites; add `name=value` for more options):",
        ...siteCommands.map((command) => `- \`${siteUsage(command)}\`: ${command.title} on ${command.site}`)
      ]
    : [];
  return [
    "Commands:",
    ...BUILT_IN_COMMANDS.map((command) => `- \`${command.usage}\`: ${command.description}`),
    "",
    skills.length ? "Your Skills:" : "You have no Skills yet. Finish a task and press **Save as Skill**.",
    ...skills.map((skill) => `- \`/${skill.slug}\`: ${skill.name}`),
    ...sites
  ].join("\n");
}
