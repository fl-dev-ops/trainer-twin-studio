import { db } from "@/lib/db";
import { callReportModel } from "@/lib/report-model";
import { TWIN_SOURCE, twinPlaybooks } from "@/lib/twins";

/**
 * Card calibrations (calibration v2): the questions a learner might bring to a twin, written from the situations its
 * skills list, kept per twin (TwinCalibrationQuestion) so coaches can see what their twin has been tested on.
 */

/** Cards a round starts with ("10 more questions" asks for another round). */
export const CARDS_PER_ROUND = 10;

/** A skill the twin answers from, with the situations it lists. */
export type CalibrationSkill = { agentId: string | null; name: string; description: string; skill: string; situations: string[]; version?: number };
/** One question to write: about this situation of this skill. */
export type QuestionSlot = { skill: CalibrationSkill; topic: string };

const SKILL_EXCERPT_CHARS = 1500;

/**
 * `count` situations to ask about, spread evenly: skills take turns, and within a skill the situations asked least so
 * far (`asked`: questions already in the pool per topic) come first, so every skill and situation is covered before
 * any repeats.
 */
export function balancedSlots(skills: CalibrationSkill[], count: number, asked: Map<string, number> = new Map()): QuestionSlot[] {
  const queues = skills
    .filter((skill) => skill.situations.length)
    .map((skill) => ({ skill, topics: [...skill.situations].sort((a, b) => (asked.get(a) ?? 0) - (asked.get(b) ?? 0)), next: 0 }));
  const slots: QuestionSlot[] = [];
  while (queues.length && slots.length < count) {
    for (const queue of queues) {
      if (slots.length >= count) break;
      slots.push({ skill: queue.skill, topic: queue.topics[queue.next % queue.topics.length] });
      queue.next += 1;
    }
  }
  return slots;
}

/** The skills a twin answers from (each with its playbook and version): every skill of an all-skills twin, or a skill twin's own. */
export async function calibrationSkills(orgId: string, twin: { slug: string; personaId: string; data: unknown }): Promise<CalibrationSkill[]> {
  const allSkills = (twin.data as { source?: unknown } | null)?.source === TWIN_SOURCE;
  const playbooks = (await twinPlaybooks(orgId, twin.personaId)).filter((playbook) => allSkills || playbook.slug === twin.slug);
  const ids = await db.agent.findMany({ where: { orgId, slug: { in: playbooks.map((playbook) => playbook.slug) } }, select: { id: true, slug: true } });
  const idOf = new Map(ids.map((row) => [row.slug, row.id]));
  return playbooks.map((playbook) => ({
    agentId: idOf.get(playbook.slug) ?? null,
    name: playbook.name,
    description: playbook.description,
    skill: playbook.skill,
    version: playbook.version,
    situations: playbook.steps.map((step) => step.name).filter((name) => typeof name === "string" && name.trim()),
  }));
}

const QUESTIONS_SYSTEM = `You write the questions a learner brings to their coach's AI twin, to test whether the twin answers the way the coach would.
For each numbered slot, write one question about that skill's situation, as the learner would type it to the twin:
- short, the way a learner types a quick question: one sentence of 5 to 12 words, e.g. "Client says 3% is too much. What do I say?"
- first person, about a real client or moment, plain words, no greeting, no "Hi coach"
- a question the coach's material can answer; never ask about the coach or the twin itself
- different from every question listed under "Already asked"`;

const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["slot", "text"], properties: { slot: { type: "integer" }, text: { type: "string" } } },
    },
  },
};

/** Writes and stores a question for each slot; returns the stored rows (slots the model skipped are left out). */
async function writeQuestions(input: { orgId: string; agentId: string; slots: QuestionSlot[]; avoid: string[] }) {
  const skills = [...new Set(input.slots.map((slot) => slot.skill))];
  const user = [
    "Skills:",
    ...skills.map((skill) => `## ${skill.name}\n${skill.description}\n${skill.skill.slice(0, SKILL_EXCERPT_CHARS)}`),
    "",
    "Slots:",
    ...input.slots.map((slot, index) => `${index}. Skill: ${slot.skill.name}. Situation: ${slot.topic}`),
    "",
    "Already asked:",
    ...(input.avoid.length ? input.avoid.map((text) => `- ${text}`) : ["(none)"]),
  ].join("\n");
  const content = await callReportModel({
    sessionId: input.agentId,
    system: QUESTIONS_SYSTEM,
    user,
    schemaName: "calibration_questions",
    schema: QUESTIONS_SCHEMA,
    meter: { source: "evaluate", orgId: input.orgId },
  });
  const written = (JSON.parse(typeof content === "string" ? content : "{}") as { questions?: { slot?: unknown; text?: unknown }[] }).questions ?? [];
  const seen = new Set(input.avoid.map((text) => text.toLowerCase()));
  const rows = written.flatMap(({ slot, text }) => {
    const target = typeof slot === "number" ? input.slots[slot] : undefined;
    const clean = typeof text === "string" ? text.trim().slice(0, 200) : "";
    if (!target || !clean || seen.has(clean.toLowerCase())) return [];
    seen.add(clean.toLowerCase());
    return [{
      orgId: input.orgId, agentId: input.agentId, skillAgentId: target.skill.agentId, topic: target.topic, text: clean,
      source: target.skill.name, origin: "generated",
    }];
  });
  if (rows.length) await db.twinCalibrationQuestion.createMany({ data: rows });
  return rows;
}

/** New questions in turn by skill, so a round never starts with three of the same skill. */
function interleaveBySkill<T extends { skillAgentId: string | null }>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.skillAgentId ?? "", [...(groups.get(row.skillAgentId ?? "") ?? []), row]);
  const out: T[] = [];
  for (let index = 0; out.length < rows.length; index += 1) {
    for (const group of groups.values()) if (group[index]) out.push(group[index]);
  }
  return out;
}

/**
 * The next round's questions for a twin: unasked ones from its pool first, then newly written ones (balanced across
 * its skills) to make up `count`. Every question written is kept. Returns fewer when the twin has no skill situations.
 */
export async function nextCalibrationQuestions(input: { orgId: string; agentId: string; count?: number }) {
  const count = input.count ?? CARDS_PER_ROUND;
  const twin = await db.agent.findFirstOrThrow({ where: { id: input.agentId, orgId: input.orgId, kind: "TWIN" }, select: { slug: true, personaId: true, data: true } });
  const pool = await db.twinCalibrationQuestion.findMany({ where: { agentId: input.agentId }, orderBy: { createdAt: "asc" } });
  const unasked = pool.filter((row) => row.status === "new");
  if (unasked.length < count) {
    const asked = new Map<string, number>();
    for (const row of pool) asked.set(row.topic, (asked.get(row.topic) ?? 0) + 1);
    const slots = balancedSlots(await calibrationSkills(input.orgId, twin), count - unasked.length, asked);
    if (slots.length) await writeQuestions({ orgId: input.orgId, agentId: input.agentId, slots, avoid: pool.map((row) => row.text) });
  }
  const fresh = await db.twinCalibrationQuestion.findMany({ where: { agentId: input.agentId, status: "new" }, orderBy: { createdAt: "asc" } });
  return interleaveBySkill(fresh).slice(0, count);
}
