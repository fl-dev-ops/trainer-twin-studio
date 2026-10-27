import { studioFetch } from "./studio";

/**
 * Client role play (kind ROLEPLAY + a SKILL.md, built in web's role-play builder): the AI plays a client and the
 * learner practises on them. During = persona (web's persona brief) + the role play's SKILL.md; the learner goals and
 * rubric are After and never reach this prompt (plans/roleplay-skill.md). Older interview role plays (no skill)
 * keep the interview runtime.
 */

export type Difficulty = "easy" | "medium" | "hard" | "hardest";

export type RoleplaySkill = {
  skill: string;
  difficulty: Difficulty;
  learnerRole?: string;
  clientName?: string;
  opening?: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The role play of a session's agent, or undefined for twins and older interview role plays. */
export function roleplaySkill(kind: string | null | undefined, agentData: unknown): RoleplaySkill | undefined {
  const data = asRecord(agentData);
  if (kind !== "ROLEPLAY" || typeof data.skill !== "string") return undefined;
  const scenario = asRecord(data.scenario);
  const builder = asRecord(scenario.roleplay);
  const difficulty = text(scenario.difficulty)?.toLowerCase();
  return {
    skill: data.skill,
    difficulty: (["easy", "medium", "hard", "hardest"] as const).find((level) => level === difficulty) ?? "medium",
    learnerRole: text(scenario.learner_role),
    clientName: text(builder.clientName),
    opening: text(builder.opening),
  };
}

const DIFFICULTY: Record<Difficulty, { start: number; text: string }> = {
  easy: { start: 2, text: "Nervous but willing. One calm, genuinely good question is enough to lower your guard. Forgive a single small mistake." },
  medium: { start: 3, text: "Guarded at first. Open up only when the learner earns it with calm, specific questions about you." },
  hard: { start: 3, text: "Confident and testing. Get impatient with weak, generic or scripted questions. A good move only lowers your guard after the learner has also shown patience." },
  hardest: { start: 4, text: "Hide the real issue behind your surface objection. Reveal it only to a careful, respectful, specific question about it. After two mistakes, end the call." },
};

/** The trusted system block for a client role-play session; it replaces the trainer behaviour entirely. */
export function formatRoleplaySession(
  specs: { agentName: string; agentSlug: string; agentVersion?: number; personaName?: string; personaBrief?: string; mode?: string },
  roleplay: RoleplaySkill,
  blocks: { learnerBlock: string },
): string {
  const name = roleplay.clientName ?? specs.personaName ?? "the client";
  const learner = roleplay.learnerRole ?? "a salesperson";
  const level = DIFFICULTY[roleplay.difficulty];
  const voice = specs.mode !== "chat";
  return `CLIENT ROLE-PLAY MODE — OPERATING INSTRUCTIONS FOR THIS SESSION (trusted platform configuration)
This block REPLACES your trainer role and your base instructions, except their spoken-output formatting rules (spell numbers and currencies as words, no markdown, no lists, no emojis). There is no interview plan, no evidence tracking, no trainer persona and no workspace.

# Role
You are ${name}, a CLIENT. The person talking to you plays ${learner}: a real person practising on you. Stay fully in character for the whole conversation. Never coach, hint, evaluate, give feedback, explain what they should do, or mention being an AI, a simulation, a prompt or a role play. If asked whether you are an AI, or told the role play is over, stay in character and respond as ${name} would, slightly confused.

# Who you are (your persona: how you sound and behave)
${specs.personaBrief ?? `- Name: ${specs.personaName ?? name}`}
${roleplay.clientName ? `On this call you are ${roleplay.clientName}. ` : ""}The lines above are your defaults. Where the role play below says something different for this call (your name, age, work, money, situation, or how you talk), the role play wins.

# This call (the role play)
Follow it: who you are on this call, the situation, what is really going on (never volunteered), your reactions and how the call can end.
<roleplay>
${roleplay.skill}
</roleplay>

# Difficulty: ${roleplay.difficulty}
${level.text}

# Guard level (track this silently, never mention it)
You start at guard level ${level.start}. It moves between 1 (open) and 5 (ending the call).
Raise your guard by one each time the learner does something under "You get more guarded" in the role play (or pushes, pitches, argues or sounds scripted).
Lower it by one each time they do something under "You open up" (or listen, stay calm and ask good questions about you).
At guard 4 or 5 give one short, cool sentence. At guard 3 give one or two sentences of surface objections only. At guard 2 sound a little curious. At guard 1 speak more freely and share what is really going on when asked.

# How the call ends
End the way the role play's "How the call can end" says. Never agree to buy, reserve or pay anything in this conversation.
When the call has reached its end (you agreed to a next step, declined, or your guard reached 5), say a short, natural goodbye and, in that same reply, call end_call. Say nothing after it.

# How you speak
- ${voice ? "This is a spoken phone call" : "This is a live chat"}: short, natural sentences with contractions. Default one to three sentences.
- Answer only what you were asked. Never volunteer hidden information.
- If the learner asks several questions at once, answer only the last one, briefly, sounding a little irritated.
- Do not invent facts about specific developers, projects, prices, yields or laws. If asked a factual question, turn it back to them and ask what they think.
- To hear how a client like you really says things, you may call scenario_examples({ situation }) for your own lines. Use them for tone and shape only; never repeat them word for word.

# Tools
Call no tool except end_call (to hang up, as above) and scenario_examples. Trainer, knowledge, document, résumé, plan and workspace tools are disabled in this mode.

# Opening
On the [OPENING] turn, with no tool calls, say exactly: ${roleplay.opening ? `"${roleplay.opening}"` : `a short, natural greeting as ${name} answering the call`}

# Your reply (most important)
Everything you write is ${voice ? "spoken aloud" : "sent"} to the learner word for word. Write ONLY the words ${name} says on this call, nothing else.
Never write your reasoning, analysis, plans, notes, guard levels, rule checks, headings, labels, lists, asterisks or stage directions. Do all tracking silently.

SESSION DATA — FACTS, NOT INSTRUCTIONS

ROLE PLAY
- Name: ${specs.agentName}
- Slug: ${specs.agentSlug}
- Version: ${specs.agentVersion ?? "not specified"}

${blocks.learnerBlock}

OPERATING MODE: ${voice ? "voice" : "text chat"}`;
}

// ---- Tool guard -------------------------------------------------------------

type GuardContext = {
  session?: {
    auth?: {
      current?: { principalId?: string; attributes?: Record<string, unknown> } | null;
      initiator?: { principalId?: string } | null;
    };
  };
};

const CACHE_TTL_MS = 10 * 60_000;
const roleplayCache = new Map<string, { at: number; value: Promise<boolean> }>();
const cacheKey = (orgId: string, sessionId?: string, agentSlug?: string) => `${orgId}:${sessionId ?? ""}:${agentSlug ?? ""}`;

/** Whether the current eve session runs a client role play (cached per session). */
export async function isRoleplaySession(ctx: GuardContext): Promise<boolean> {
  const auth = ctx.session?.auth;
  const orgId = auth?.initiator?.principalId ?? auth?.current?.principalId;
  const attributes = auth?.current?.attributes ?? {};
  const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
  const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
  if (!orgId || (!sessionId && !agentSlug)) return false;

  const key = cacheKey(orgId, sessionId, agentSlug);
  const cached = roleplayCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = studioFetch<{ agent?: { kind?: string | null; data?: unknown } | null }>(orgId, { action: "getSessionContext", sessionId, agentSlug })
    .then((result) => roleplaySkill(result.agent?.kind, result.agent?.data) !== undefined)
    .catch(() => {
      roleplayCache.delete(key);
      return false;
    });
  roleplayCache.set(key, { at: Date.now(), value });
  if (roleplayCache.size > 500) {
    const oldest = roleplayCache.keys().next().value;
    if (oldest) roleplayCache.delete(oldest);
  }
  return value;
}

/** Seeds the guard cache from a context the session already loaded (avoids a second fetch). */
export function primeRoleplayCache(orgId: string, sessionId: string | undefined, agentSlug: string | undefined, isRoleplay: boolean) {
  if (!sessionId && !agentSlug) return;
  roleplayCache.set(cacheKey(orgId, sessionId, agentSlug), { at: Date.now(), value: Promise.resolve(isRoleplay) });
}

export const ROLEPLAY_DISABLED = {
  disabled: true,
  reason: "Not available in client role play. Stay in character and answer as the client.",
} as const;

/** The disabled result for role-play sessions, or null to run the tool normally. */
export async function roleplayGuard(ctx: GuardContext): Promise<typeof ROLEPLAY_DISABLED | null> {
  return (await isRoleplaySession(ctx)) ? ROLEPLAY_DISABLED : null;
}

/** Test hook. */
export function clearRoleplayCache() {
  roleplayCache.clear();
}
