import { defineDynamic, defineInstructions } from "eve/instructions";
import {
  loadSessionContext,
  TWIN_LINES_MIN_WORDS,
  TWIN_LINES_PER_TURN,
  type TwinExample,
  formatTwinMomentLines,
  twinLinesQuery,
} from "../lib/brain";
import { studioFetch } from "../lib/studio";
import { writeTwinQuery } from "../lib/twin-query";

/** Inputs that are not the learner speaking: openings, tool results, nudges and calibration marks get no lines. */
const NOT_LEARNER = ["[OPENING]", "[TOOL RESULT]", "[USER INACTIVE]", "[CALIBRATION FEEDBACK]"];
/** A slow query model must not hold the turn: past this the search uses the learner's words. */
const QUERY_TIMEOUT_MS = 2_000;
/** A slow lookup must not hold the turn: without lines the twin advises from the playbook alone. */
const LOOKUP_TIMEOUT_MS = 3_000;

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("")
      : "";

/**
 * Small twins (playbooks in the prompt): before each learner turn, the trainer's lines for this moment, so the twin's
 * model fits its advice to it in one call. Replaces eve__skill → scenario_examples → answer (two extra calls on the
 * twin's model) with one small fast call that writes the search (lib/twin-query.ts). Three picked lines beat all lines
 * in the prompt in the Nov 6 replay (the model reused stock lines everywhere).
 */
export default defineDynamic(async (ctx) => {
  const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
  const attributes = (ctx.session.auth.current?.attributes ?? {}) as Record<string, string | undefined>;
  if (!orgId) return null;

  // Once per session: a small twin's playbooks (in its prompt), and a warm lookup path for its first turn.
  const twin = await ctx.memo(["twin-lines:twin", ctx.session.id], async () => {
    const mode = (attributes.mode === "chat" ? "chat" : "voice") as "voice" | "chat";
    const clientTools = (attributes.clientTools ?? "").split(",").filter(Boolean);
    const specs = await loadSessionContext(orgId, attributes.sessionId, attributes.agentSlug, attributes.personaSlug, mode, clientTools)
      .catch(() => null);
    if (!specs?.twin?.inline) return null;
    // Warm the vector store connection and embeddings during the countdown. Best effort.
    void studioFetch(orgId, { action: "searchScenarioItems", agentSlug: specs.agentSlug, query: "warm up", role: "trainer", limit: 1, sessionId: attributes.sessionId })
      .catch(() => {});
    return { agentSlug: specs.agentSlug, personaName: specs.personaName ?? specs.personaSlug ?? "the trainer", playbooks: specs.twin.inline };
  });
  if (!twin) return null;

  // Once per turn: eve runs this before every model call, including a turn's tool follow-ups.
  const content = await ctx.memo(["twin-lines:turn", ctx.turn?.id ?? null], async () => {
    // This turn's message comes from the bridge (openai-compat sets turnText).
    const heard = (attributes.turnText ?? "").trim();
    if (!heard || NOT_LEARNER.some((tag) => heard.startsWith(tag)) || heard.split(/\s+/).length < TWIN_LINES_MIN_WORDS) return null;
    const lastReply = textOf([...(await ctx.messages())].reverse().find((m) => m.role === "assistant")?.content);

    // 1. A small fast model names the playbook and situation and writes the search, as the old flow's model did.
    const startedAt = Date.now();
    const reading = await writeTwinQuery(twin.playbooks, heard, lastReply, AbortSignal.timeout(QUERY_TIMEOUT_MS)).catch((error) => {
      console.error("[twin-lines] query model failed", error instanceof Error ? error.message : error);
      return null;
    });
    const queryMs = Date.now() - startedAt;
    // The query model saw no client moment (thanks, small talk, a question about the call): no lines this turn.
    if (reading && "skip" in reading) {
      console.info("[twin-lines] " + JSON.stringify({ sessionId: attributes.sessionId ?? null, at_ms: Date.now(), heard_words: heard.split(/\s+/).length, query_ms: queryMs, skipped: true }));
      return null;
    }
    const written = reading;
    // 2. The trainer's lines for it; without a written query, the learner's words across every playbook.
    const query = written?.query ?? twinLinesQuery(heard, lastReply);
    const result = await studioFetch<{ examples?: TwinExample[] }>(orgId, {
      action: "searchScenarioItems",
      agentSlug: twin.agentSlug,
      query,
      role: "trainer",
      limit: TWIN_LINES_PER_TURN,
      sessionId: attributes.sessionId,
      ...(written ? { playbook: written.playbook, ...(written.step ? { step: written.step } : {}) } : {}),
      // Real sessions only: keep these lines for the turn's "Why this answer" (web/lib/twin/evidence.ts).
      ...(attributes.recordEvidence === "1" ? { recordTurnLines: { heard: heard.slice(0, 4000), situation: query } } : {}),
    }, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)).catch((error) => {
      console.error("[twin-lines] lookup failed", error instanceof Error ? error.message : error);
      return null;
    });
    const lines = (result?.examples ?? []).filter((line) => line.text?.trim());
    console.info("[twin-lines] " + JSON.stringify({
      sessionId: attributes.sessionId ?? null,
      at_ms: Date.now(),
      heard_words: heard.split(/\s+/).length,
      query_ms: queryMs,
      lookup_ms: Date.now() - startedAt - queryMs,
      written: written ? { playbook: written.playbook, step: written.step ?? null } : null,
      lines: lines.length,
      situations: lines.map((line) => line.step ?? null),
    }));
    if (lines.length === 0) return null;
    return formatTwinMomentLines(twin.playbooks, lines, twin.personaName, written);
  });
  return content ? defineInstructions({ role: "user", content }) : null;
});
