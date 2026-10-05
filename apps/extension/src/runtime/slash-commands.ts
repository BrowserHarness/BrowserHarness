// Slash commands typed in the chat box: built-ins plus one per saved Skill.
import type { UserSkill } from "./skills";

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
  { name: "help", usage: "/help", description: "List every command" }
];

export type SlashCommand =
  | { kind: "none" }
  | { kind: "builtin"; name: string; args: string }
  | { kind: "skill"; skill: UserSkill; args: string }
  | { kind: "unknown"; name: string };

export function parseSlashCommand(text: string, skills: UserSkill[]): SlashCommand {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { kind: "none" };
  const name = match[1].toLowerCase();
  const args = (match[2] || "").trim();
  if (BUILT_IN_COMMANDS.some((command) => command.name === name)) return { kind: "builtin", name, args };
  const skill = skills.find((item) => item.slug === name);
  return skill ? { kind: "skill", skill, args } : { kind: "unknown", name };
}

/** Commands matching what has been typed so far ("/" or "/rem"). */
export function slashSuggestions(text: string, skills: UserSkill[]): SlashCommandInfo[] {
  const match = /^\/([a-z0-9-]*)$/i.exec(text);
  if (!match) return [];
  const typed = match[1].toLowerCase();
  const all = [
    ...BUILT_IN_COMMANDS,
    ...skills.map((skill) => ({
      name: skill.slug,
      usage: `/${skill.slug} [details]`,
      description: skill.name
    }))
  ];
  return all.filter((command) => command.name.startsWith(typed)).slice(0, 8);
}

export function helpText(skills: UserSkill[]): string {
  return [
    "Commands:",
    ...BUILT_IN_COMMANDS.map((command) => `- \`${command.usage}\`: ${command.description}`),
    "",
    skills.length ? "Your Skills:" : "You have no Skills yet. Finish a task and press **Save as Skill**.",
    ...skills.map((skill) => `- \`/${skill.slug}\`: ${skill.name}`)
  ].join("\n");
}
