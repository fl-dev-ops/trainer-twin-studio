/**
 * What the copilot composer adds to a message (plans/copilot-v2.md): the skill picked from the "/" menu and the
 * knowledge-base files picked from Files, as tags the copilot reads (copilot/agent/instructions.md). The chat shows
 * them as chips, not as text.
 */

export const COPILOT_SKILLS = [
  { name: "twin-creator", label: "Twin skill", description: "Build or update a twin skill from your knowledge" },
  { name: "roleplay-creator", label: "Role play", description: "Build or change a role play from your recordings" },
] as const;
export type CopilotSkillName = (typeof COPILOT_SKILLS)[number]["name"];
export type PickedFile = { id: string; title: string; ext?: string };
export type CopilotMessage = { skill?: CopilotSkillName; files: PickedFile[]; text: string };

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unattr = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function encodeCopilotMessage({ skill, files, text }: CopilotMessage): string {
  const head = [
    ...(skill ? [`<use-skill name="${skill}" />`] : []),
    ...(files.length
      ? ["<selected-files>", ...files.map((file) => `<file id="${attr(file.id)}" title="${attr(file.title)}" />`), "</selected-files>"]
      : []),
  ];
  return head.length ? `${head.join("\n")}\n\n${text}`.trimEnd() : text;
}

const SKILL_TAG = /^<use-skill name="([a-z-]+)" \/>\n?/;
const FILES_BLOCK = /^<selected-files>\n([\s\S]*?)\n?<\/selected-files>\n?/;
const FILE_TAG = /<file id="([^"]*)" title="([^"]*)" \/>/g;

/** The skill and files a sent message carries, and the text the trainer typed. */
export function decodeCopilotMessage(raw: string): CopilotMessage {
  let rest = raw;
  let skill: CopilotSkillName | undefined;
  const files: PickedFile[] = [];
  const skillMatch = rest.match(SKILL_TAG);
  if (skillMatch && COPILOT_SKILLS.some((s) => s.name === skillMatch[1])) {
    skill = skillMatch[1] as CopilotSkillName;
    rest = rest.slice(skillMatch[0].length);
  }
  const filesMatch = rest.match(FILES_BLOCK);
  if (filesMatch) {
    for (const m of filesMatch[1].matchAll(FILE_TAG)) files.push({ id: unattr(m[1]), title: unattr(m[2]) });
    rest = rest.slice(filesMatch[0].length);
  }
  return { skill, files, text: rest.replace(/^\n+/, "") };
}

/** The "/" menu: open while the input is "/" plus an optional filter, and no skill is picked yet. */
export function slashQuery(input: string): string | null {
  const m = input.match(/^\/([a-z -]*)$/i);
  return m ? m[1].trim().toLowerCase() : null;
}

export const matchingSkills = (query: string) =>
  COPILOT_SKILLS.filter((skill) => !query || skill.label.toLowerCase().includes(query) || skill.name.includes(query));
