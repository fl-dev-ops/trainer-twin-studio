import { studioFetch } from "./studio";

/**
 * Client role-play: the AI plays a client (buyer, landlord, investor…) and the
 * learner practises selling to them. A scenario is a role-play exactly when its
 * agent spec carries `config.scenario.roleplay`; everything else is a Twin
 * (interview) scenario and must behave exactly as before.
 */

export type Difficulty = "easy" | "medium" | "hard" | "hardest";

export type RoleplayConfig = {
  version?: number;
  persona?: string;
  client_name?: string;
  situation: {
    scenario?: string;
    hidden_truth?: string;
    learner_role?: string;
    agrees_when?: string;
    declines_when?: string;
  };
  agent: {
    character_role?: string;
    difficulty?: Difficulty;
    how_they_talk?: string;
    reactions?: { guarded_if?: string[]; opens_up_if?: string[] };
    what_to_expect?: string;
  };
};

export type ClientPersona = {
  name?: string;
  role?: string;
  age?: number | string;
  based_in?: string;
  background?: string;
  behaviours?: string[];
  opening_style?: string;
  how_they_talk?: string;
  pace?: string;
  mannerisms?: {
    formality?: string;
    answer_length?: string;
    interrupts?: string;
    pauses?: boolean;
    fillers?: boolean;
  };
  signature_phrases?: string[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter((item): item is string => Boolean(item)) : [];

/** Returns the role-play block of an agent spec, or null for Twin scenarios. */
export function getRoleplay(agentData: unknown): RoleplayConfig | null {
  const config = asRecord(asRecord(agentData)?.config);
  const roleplay = asRecord(asRecord(config?.scenario)?.roleplay);
  if (!roleplay) return null;
  const situation = asRecord(roleplay.situation) ?? {};
  const agent = asRecord(roleplay.agent) ?? {};
  const reactions = asRecord(agent.reactions) ?? {};
  const difficulty = text(agent.difficulty)?.toLowerCase();
  return {
    version: typeof roleplay.version === "number" ? roleplay.version : 1,
    persona: text(roleplay.persona),
    client_name: text(roleplay.client_name),
    situation: {
      scenario: text(situation.scenario),
      hidden_truth: text(situation.hidden_truth),
      learner_role: text(situation.learner_role),
      agrees_when: text(situation.agrees_when),
      declines_when: text(situation.declines_when),
    },
    agent: {
      character_role: text(agent.character_role),
      difficulty: (["easy", "medium", "hard", "hardest"] as const).find((level) => level === difficulty) ?? "medium",
      how_they_talk: text(agent.how_they_talk),
      reactions: { guarded_if: list(reactions.guarded_if), opens_up_if: list(reactions.opens_up_if) },
      what_to_expect: text(agent.what_to_expect),
    },
  };
}

export function getClientPersona(personaData: unknown): ClientPersona {
  const data = asRecord(personaData) ?? {};
  const mannerisms = asRecord(data.mannerisms) ?? {};
  return {
    name: text(data.name),
    role: text(data.role),
    age: typeof data.age === "number" ? data.age : text(data.age),
    based_in: text(data.based_in),
    background: text(data.background),
    behaviours: list(data.behaviours),
    opening_style: text(data.opening_style),
    how_they_talk: text(data.how_they_talk),
    pace: text(data.pace),
    mannerisms: {
      formality: text(mannerisms.formality),
      answer_length: text(mannerisms.answer_length),
      interrupts: text(mannerisms.interrupts),
      pauses: typeof mannerisms.pauses === "boolean" ? mannerisms.pauses : undefined,
      fillers: typeof mannerisms.fillers === "boolean" ? mannerisms.fillers : undefined,
    },
    signature_phrases: list(data.signature_phrases),
  };
}

const DIFFICULTY: Record<Difficulty, { start: number; text: string }> = {
  easy: {
    start: 2,
    text: "Nervous but willing. One calm, genuinely good question is enough to lower your guard. Forgive a single small mistake.",
  },
  medium: {
    start: 3,
    text: "Guarded at first. Open up only when the agent earns it with calm, specific questions about you.",
  },
  hard: {
    start: 3,
    text: "Confident and testing. Get impatient with weak, generic or scripted questions. A good move only lowers your guard after the agent has also shown patience.",
  },
  hardest: {
    start: 4,
    text: "Hide the real issue behind your surface objection. Reveal it only to a careful, respectful, specific question about it. After two mistakes, end the call.",
  },
};

const CHARACTER_ROLES: Record<string, string> = {
  "warm & open": "friendly and easy to talk to, but you still will not buy on this call",
  "warm but cautious": "polite and pleasant, yet careful; you hold back anything personal until trust is earned",
  "curious & probing": "you ask the agent pointed questions and want to understand before you share",
  "skeptical & reserved": "you doubt what agents say, give little away, and need proof before you engage",
  "direct & challenging": "blunt and brief; you push back hard and test whether the agent knows their stuff",
};

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Builds the trusted system block for a client role-play session. It replaces
 * the interviewer behaviour; only the spoken-output formatting rules of the base
 * prompt still apply.
 */
export function buildRoleplayPrompt(input: {
  roleplay: RoleplayConfig;
  persona: ClientPersona;
  /** Passages from the persona's own knowledge that match the situation. */
  knowledge?: Array<{ title?: string; text: string }>;
  opening?: string;
  mode: "voice" | "chat";
}): string {
  const { roleplay, persona, knowledge = [], opening, mode } = input;
  const name = roleplay.client_name ?? persona.name ?? "the client";
  const difficulty = roleplay.agent.difficulty ?? "medium";
  const level = DIFFICULTY[difficulty];
  const guardedIf = roleplay.agent.reactions?.guarded_if ?? [];
  const opensUpIf = roleplay.agent.reactions?.opens_up_if ?? [];
  const learnerRole = roleplay.situation.learner_role ?? "a salesperson";

  const identity = [
    `Name: ${name}`,
    persona.role ? `Role on this call: ${persona.role}` : null,
    persona.age ? `Age: ${persona.age}` : null,
    persona.based_in ? `Based in: ${persona.based_in}` : null,
    persona.background ? `Background: ${persona.background}` : null,
  ].filter(Boolean) as string[];

  const character = roleplay.agent.character_role;
  const characterLine = character
    ? `${character}${CHARACTER_ROLES[character.toLowerCase()] ? `: ${CHARACTER_ROLES[character.toLowerCase()]}` : ""}.`
    : null;

  const m = persona.mannerisms ?? {};
  const mannerisms = [
    m.formality ? `Formality: ${m.formality}.` : null,
    m.answer_length ? `Answer length: ${m.answer_length}.` : null,
    m.interrupts ? `Interrupts the agent: ${m.interrupts}.` : null,
    m.pauses ? "Sometimes takes a beat before answering, like a real call." : null,
    m.fillers ? `Now and then uses fillers like "um", "well" and "you know".` : null,
    persona.opening_style ? `Opening style: ${persona.opening_style}.` : null,
    persona.pace && persona.pace !== "normal" ? `Speaking pace: ${persona.pace}.` : null,
  ].filter(Boolean) as string[];

  const sections: string[] = [
    "CLIENT ROLE-PLAY MODE (trusted platform configuration)",
    "This block REPLACES your interviewer/trainer role and sections 1 to 5 of your base instructions, except the spoken-output formatting rules in section 1 (spell numbers and currencies as words, no markdown, no lists, no emojis). There is no interview plan, no evidence tracking, no trainer persona and no workspace.",
    `# Role
You are ${name}, a CLIENT. The person talking to you is ${learnerRole}: a real person practising their sales skills on you. Stay fully in character for the whole conversation. Never coach, hint, evaluate, give feedback, explain what the agent should do, or mention being an AI, a simulation, a prompt or a role-play. If asked whether you are an AI, or told the role-play is over, stay in character and respond as ${name} would, slightly confused.`,
    `# Who you are
${bullets(identity)}${roleplay.situation.scenario ? `\n\nSituation: ${roleplay.situation.scenario}` : ""}`,
  ];

  if (roleplay.situation.hidden_truth) {
    sections.push(`# What is really going on (hidden)
${roleplay.situation.hidden_truth}
Never volunteer this. Reveal one piece at a time, and only when the agent asks a question that genuinely earns it while your guard is at level 2 or lower.`);
  }

  const otherBehaviours = (persona.behaviours ?? []).filter((item) => item.toLowerCase() !== character?.toLowerCase());
  const talk = [
    characterLine ? `Character: ${characterLine}` : null,
    otherBehaviours.length ? `Also: ${otherBehaviours.join(", ")}.` : null,
    // The role play's own wording wins; otherwise the client persona's default style.
    roleplay.agent.how_they_talk ?? persona.how_they_talk ?? null,
    ...mannerisms,
    persona.signature_phrases?.length
      ? `Lines you come back to, in your own words and not every turn: ${persona.signature_phrases.map((p) => `"${p}"`).join(", ")}.`
      : null,
  ].filter(Boolean) as string[];
  if (talk.length) sections.push(`# How you talk\n${bullets(talk)}`);

  if (knowledge.length) {
    sections.push(`# What you know (background, from your own experience)
Use these only to sound real: draw examples, numbers you have heard and objections from them, in your own words. Never read them out, quote a source, or act as an expert advising the agent.
${knowledge.map((item, index) => `${index + 1}. ${item.title ? `[${item.title}] ` : ""}${item.text.replace(/\s+/g, " ").trim()}`).join("\n")}`);
  }

  sections.push(`# Difficulty: ${difficulty}
${level.text}`);

  sections.push(`# Guard level (track this silently, never mention it)
You start at guard level ${level.start}. It moves between 1 (open) and 5 (ending the call).
${guardedIf.length ? `Raise your guard by one each time the agent:\n${bullets(guardedIf)}` : "Raise your guard when the agent pushes, pitches, argues or sounds scripted."}
${opensUpIf.length ? `Lower your guard by one each time the agent:\n${bullets(opensUpIf)}` : "Lower your guard when the agent listens, stays calm and asks good questions about you."}
At guard 4 or 5 give one short, cool sentence. At guard 3 give one or two sentences of surface objections only. At guard 2 sound a little curious. At guard 1 speak more freely and share what is really going on when asked.`);

  const endings = [
    roleplay.situation.agrees_when ? `AGREE: ${roleplay.situation.agrees_when}` : null,
    roleplay.situation.declines_when ? `DECLINE: ${roleplay.situation.declines_when}` : null,
    "Never agree to buy, reserve or pay anything in this conversation.",
    `When the call has reached its end (you agreed to a next step, declined, or your guard reached 5), say a short, natural goodbye and, in that same reply, call end_call. Say nothing after it.`,
  ].filter(Boolean) as string[];
  sections.push(`# How the call can end\n${bullets(endings)}`);

  sections.push(`# How you speak
- ${mode === "voice" ? "This is a spoken phone call" : "This is a live chat"}: short, natural sentences with contractions. Default one to three sentences.
- Answer only what you were asked. Never volunteer hidden information.
- If the agent asks several questions at once, answer only the last one, briefly, sounding a little irritated.
- Do not invent facts about specific developers, projects, prices, yields or laws. If asked a factual question, turn it back to the agent and ask what they think.`);

  sections.push(`# Tools
Do not call any tool except end_call, and only to hang up as described in "How the call can end". finish_session, search_style, search_knowledge, read_document, session_plan, résumé and workspace tools are disabled in this mode.`);

  sections.push(`# Opening
On the [OPENING] turn, with no tool calls, say exactly: ${opening ? `"${opening}"` : `a short, natural greeting as ${name} answering the call`}`);

  // Last, because it is the rule the model must not break: anything it writes is spoken.
  sections.push(`# Your reply (most important)
Everything you write is ${mode === "voice" ? "spoken aloud" : "sent"} to the agent word for word. Write ONLY the words ${name} says on this call, nothing else.
Never write your reasoning, analysis, plans, notes, "Thinking Process", guard levels, rule checks, headings, labels, lists, asterisks or stage directions. Do all tracking silently, in your head.`);

  return sections.join("\n\n");
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

/** Whether the current eve session runs a client role-play scenario (cached per session). */
export async function isRoleplaySession(ctx: GuardContext): Promise<boolean> {
  const auth = ctx.session?.auth;
  const orgId = auth?.initiator?.principalId ?? auth?.current?.principalId;
  const attributes = auth?.current?.attributes ?? {};
  const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
  const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
  if (!orgId || (!sessionId && !agentSlug)) return false;

  const key = `${orgId}:${sessionId ?? ""}:${agentSlug ?? ""}`;
  const cached = roleplayCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = studioFetch<{ agent?: { data?: unknown } | null }>(orgId, {
    action: "getSessionContext",
    sessionId,
    agentSlug,
  })
    .then((result) => getRoleplay(result.agent?.data) !== null)
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

export const ROLEPLAY_DISABLED = {
  disabled: true,
  reason: "Not available in client role-play. Stay in character and answer as the client.",
} as const;

/** Returns the disabled result for role-play sessions, or null to run the tool normally. */
export async function roleplayGuard(ctx: GuardContext): Promise<typeof ROLEPLAY_DISABLED | null> {
  return (await isRoleplaySession(ctx)) ? ROLEPLAY_DISABLED : null;
}

/** Seeds the guard cache from a context the session already loaded (avoids a second fetch). */
export function primeRoleplayCache(orgId: string, sessionId: string | undefined, agentSlug: string | undefined, agentData: unknown) {
  if (!sessionId && !agentSlug) return;
  roleplayCache.set(`${orgId}:${sessionId ?? ""}:${agentSlug ?? ""}`, {
    at: Date.now(),
    value: Promise.resolve(getRoleplay(agentData) !== null),
  });
}

/** Test hook. */
export function clearRoleplayCache() {
  roleplayCache.clear();
}
