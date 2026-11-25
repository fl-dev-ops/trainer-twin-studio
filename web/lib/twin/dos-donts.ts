import { db } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { callReportModel } from "@/lib/report-model";
import { calibrationCoach } from "@/lib/twin/calibration-cards";
import { calibrationSkills, type CalibrationSkill } from "@/lib/twin/calibration-questions";

/**
 * A twin's Do's & Don'ts per topic (the Configure tab). The first time a topic is shown, its main rules are picked from
 * the skill's playbook, each as a crisp line with the playbook's sentence kept beside it (checked word for word), and
 * saved; from then on the list is fixed and only the coach changes it
 * (edit, add, remove). Nothing here changes the skill files yet: her changes are kept beside the playbook's wording
 * until we decide how they apply.
 */

/** Rules picked per kind and topic. */
export const RULES_PER_KIND = 3;
const MAX_RULE_CHARS = 500;
/** A rule as shown: crisp, like the prototype's ("Ask one question back before giving advice"). */
const MAX_CRISP_WORDS = 14;

export type DoDontKind = "do" | "dont";

const PICK_SYSTEM = `You read a coach's playbook (written by the coach, in the first person) and pick her main rules.
- "dos": the ${RULES_PER_KIND} most important things she does or always does in this topic.
- "donts": the ${RULES_PER_KIND} most important things she never does or does not do in this topic.
For each rule give two things:
- "original": the single sentence EXACTLY as it is written in the playbook: no rewording, no merging, no words of your own.
- "crisp": the same rule as a short instruction to her twin, at most 10 words, starting with a verb, keeping her own key words. A Do says what to do ("Ask what they compare it to before defending price"). A Don't says what to avoid, without "don't" or "never" (it is listed under Don't): "Defend the price before you know the real objection".
Prefer rules from "How I decide" and "My approach".`;

const RULE_SCHEMA = {
  type: "array",
  items: { type: "object", additionalProperties: false, required: ["original", "crisp"], properties: { original: { type: "string" }, crisp: { type: "string" } } },
};
const PICK_SCHEMA = { type: "object", additionalProperties: false, required: ["dos", "donts"], properties: { dos: RULE_SCHEMA, donts: RULE_SCHEMA } };

/** Text compared loosely: whitespace, quote styles and a leading list dash don't matter. */
const loose = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim();

/**
 * Picked rules worth keeping: its original sentence appears in the playbook as written (a model that rewords is caught
 * here), and its crisp line is short. Each as { text: the crisp line, original: the playbook's sentence }.
 */
export function verbatimRules(picked: unknown, playbook: string): { text: string; original: string }[] {
  const source = loose(playbook);
  const seen = new Set<string>();
  return (Array.isArray(picked) ? picked : []).flatMap((rule) => {
    const { original, crisp } = (rule && typeof rule === "object" ? rule : {}) as { original?: unknown; crisp?: unknown };
    const sentence = typeof original === "string" ? loose(original) : "";
    const line = typeof crisp === "string" ? crisp.replace(/\s+/g, " ").trim().replace(/\.$/, "") : "";
    const words = line.split(" ").filter(Boolean).length;
    if (sentence.length < 8 || sentence.length > MAX_RULE_CHARS || !source.includes(sentence) || seen.has(sentence)) return [];
    if (words < 2 || words > MAX_CRISP_WORDS) return [];
    seen.add(sentence);
    return [{ text: line, original: sentence }];
  }).slice(0, RULES_PER_KIND);
}

/** Picks and saves a topic's Do's and Don'ts from its playbook, once (a second caller's rows are skipped). */
async function pickTopic(orgId: string, agentId: string, skill: CalibrationSkill & { agentId: string }) {
  const content = await callReportModel({
    sessionId: agentId,
    system: PICK_SYSTEM,
    user: `Topic: ${skill.name}\n\nPlaybook:\n${skill.skill}`,
    schemaName: "twin_dos_donts",
    schema: PICK_SCHEMA,
    meter: { source: "evaluate", orgId },
  });
  const picked = JSON.parse(typeof content === "string" ? content : "{}") as { dos?: unknown; donts?: unknown };
  const rows = (["do", "dont"] as const).flatMap((kind) =>
    verbatimRules(kind === "do" ? picked.dos : picked.donts, skill.skill).map((rule, position) => ({
      orgId, agentId, skillAgentId: skill.agentId, skillVersion: skill.version ?? 1, kind, position, text: rule.text, originalText: rule.original, source: "playbook",
    })),
  );
  if (rows.length) await db.twinDoDont.createMany({ data: rows, skipDuplicates: true });
}

/**
 * The twin's Do's & Don'ts by topic. A topic seen for the first time has its rules picked from its playbook now
 * (once); every later call returns the saved list as it stands. Removed lines are left out; a team member's change
 * is marked as a suggestion (only the coach's count when changes are applied later).
 */
export async function twinDosDonts(input: { orgId: string; agentId: string }) {
  const twin = await db.agent.findFirstOrThrow({ where: { id: input.agentId, orgId: input.orgId, kind: "TWIN" }, select: { slug: true, personaId: true, data: true } });
  const skills = (await calibrationSkills(input.orgId, twin)).filter((skill): skill is CalibrationSkill & { agentId: string } => Boolean(skill.agentId));
  const picked = new Set((await db.twinDoDont.findMany({
    where: { agentId: input.agentId }, distinct: ["skillAgentId"], select: { skillAgentId: true },
  })).map((row) => row.skillAgentId));
  await Promise.all(skills.filter((skill) => !picked.has(skill.agentId)).map((skill) => pickTopic(input.orgId, input.agentId, skill)));

  const [rows, coach] = await Promise.all([
    db.twinDoDont.findMany({ where: { agentId: input.agentId, removedAt: null }, orderBy: [{ kind: "asc" }, { position: "asc" }] }),
    calibrationCoach(input.orgId),
  ]);
  const editors = new Map((await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.editedByUserId).filter((id): id is string => Boolean(id)))] } },
    select: { id: true, name: true, email: true },
  })).map((user) => [user.id, user.name || user.email]));
  const item = (row: (typeof rows)[number]) => ({
    id: row.id,
    kind: row.kind as DoDontKind,
    text: row.text,
    originalText: row.originalText,
    source: row.source as "playbook" | "edited" | "added",
    editedBy: row.editedByUserId ? editors.get(row.editedByUserId) ?? null : null,
    suggestion: Boolean(row.editedByUserId && row.editedByUserId !== coach?.userId),
  });
  return skills.map((skill) => {
    const mine = rows.filter((row) => row.skillAgentId === skill.agentId);
    return {
      skillAgentId: skill.agentId,
      name: skill.name,
      dos: mine.filter((row) => row.kind === "do").map(item),
      donts: mine.filter((row) => row.kind === "dont").map(item),
    };
  });
}

/** One of this org's lines, for a change. */
async function ownRow(orgId: string, id: string) {
  const row = await db.twinDoDont.findFirst({ where: { id, orgId } });
  if (!row) throw refusals.notFound();
  return row;
}

const cleanText = (text: string) => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw refusals.invalidInput("Write the rule");
  if (clean.length > MAX_RULE_CHARS) throw refusals.invalidInput(`Keep it under ${MAX_RULE_CHARS} characters`);
  return clean;
};

/** Changes a line's wording (the playbook's sentence stays beside it). Changed to the playbook's sentence, it is the playbook's line again. */
export async function editDoDont(input: { orgId: string; userId: string; id: string; text: string }) {
  const row = await ownRow(input.orgId, input.id);
  const text = cleanText(input.text);
  const source = row.source === "added" ? "added" : text === row.originalText ? "playbook" : "edited";
  await db.twinDoDont.update({ where: { id: row.id }, data: { text, source, editedByUserId: input.userId } });
  return { ok: true };
}

/** Adds her own line to a topic's Do's or Don'ts, after the others. */
export async function addDoDont(input: { orgId: string; userId: string; agentId: string; skillAgentId: string; kind: DoDontKind; text: string }) {
  const text = cleanText(input.text);
  // A topic of this twin: its list exists once the tab has been opened.
  const topic = await db.twinDoDont.findFirst({ where: { orgId: input.orgId, agentId: input.agentId, skillAgentId: input.skillAgentId }, select: { skillVersion: true } });
  if (!topic) throw refusals.notFound();
  for (let attempt = 0; ; attempt++) {
    const last = await db.twinDoDont.findFirst({
      where: { agentId: input.agentId, skillAgentId: input.skillAgentId, kind: input.kind }, orderBy: { position: "desc" }, select: { position: true },
    });
    try {
      const row = await db.twinDoDont.create({
        data: {
          orgId: input.orgId, agentId: input.agentId, skillAgentId: input.skillAgentId, skillVersion: topic.skillVersion, kind: input.kind,
          position: (last?.position ?? -1) + 1, text, originalText: null, source: "added", editedByUserId: input.userId,
        },
        select: { id: true },
      });
      return row;
    } catch (error) {
      // Two added at once took the same position: take the next one.
      if ((error as { code?: unknown }).code !== "P2002" || attempt >= 2) throw error;
    }
  }
}

/** Removes a line from the list (kept, and can be restored). */
export async function removeDoDont(input: { orgId: string; userId: string; id: string; restore?: boolean }) {
  const row = await ownRow(input.orgId, input.id);
  await db.twinDoDont.update({ where: { id: row.id }, data: { removedAt: input.restore ? null : new Date(), editedByUserId: input.userId } });
  return { ok: true };
}
