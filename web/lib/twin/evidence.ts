import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * "Why this answer": per brain turn of a twin session, what the twin heard, what it looked up and the moments that came
 * back. The chat runtime posts each turn (studio action recordTurnEvidence); the calibration call shows it.
 */

const MAX_EVIDENCE_BYTES = 60_000;

export const turnEvidenceSchema = z.object({
  sessionId: z.string().min(1).max(100),
  heard: z.string().max(4000),
  reply: z.string().max(8000),
  inputKind: z.string().max(40),
  calls: z.array(z.object({ tool: z.string().min(1).max(80), input: z.unknown(), output: z.unknown() })).max(12),
});
export type TurnEvidenceInput = z.infer<typeof turnEvidenceSchema>;

/** Stores one turn's evidence when the session is a twin session of the org; anything else is ignored. */
export async function recordTurnEvidence(orgId: string, input: TurnEvidenceInput) {
  const session = await db.interviewSession.findFirst({
    where: { id: input.sessionId, orgId, agent: { kind: "TWIN" } },
    select: { id: true },
  });
  if (!session) return { stored: false };
  const { sessionId, ...data } = input;
  // A small twin gets its lines before each turn (chat/agent/instructions/twin-lines.ts), recorded by the studio search
  // as a pending row: move them onto this turn, so the panel shows exactly the lines the twin was given.
  if (data.inputKind === "learner" && !data.calls.some((call) => call.tool === "scenario_examples")) {
    const pending = await db.twinTurnEvidence.findFirst({
      where: { sessionId, createdAt: { gte: new Date(Date.now() - TURN_LINES_MAX_AGE_MS) } },
      orderBy: { createdAt: "desc" },
      select: { id: true, data: true },
    });
    const lines = asRecord(pending?.data);
    if (pending && lines.inputKind === TURN_LINES && text(lines.heard) === text(data.heard)) {
      data.calls = [...data.calls, ...(Array.isArray(lines.calls) ? lines.calls : []).map(asRecord).map((call) => ({ tool: String(call.tool), input: call.input, output: call.output }))];
      await db.twinTurnEvidence.delete({ where: { id: pending.id } });
    }
  }
  // Tool outputs can be long: keep the row bounded (calls are dropped, heard/reply stay).
  const fits = JSON.stringify(data).length <= MAX_EVIDENCE_BYTES;
  await db.twinTurnEvidence.create({
    data: { sessionId, data: (fits ? data : { ...data, calls: [], truncated: true }) as Prisma.InputJsonValue },
  });
  return { stored: true };
}

/** A pending row of the lines a small twin was given for a turn, until recordTurnEvidence moves them onto that turn. */
const TURN_LINES = "turn_lines";
/** Lines older than this belong to a turn that never got a reply; they are left out. */
const TURN_LINES_MAX_AGE_MS = 5 * 60_000;

/** Keeps the lines a small twin's turn was given (studio searchScenarioItems with recordTurnLines), off its critical path. */
export async function recordTurnLines(
  orgId: string,
  sessionId: string,
  input: { heard: string; situation: string; examples: unknown[] },
) {
  const session = await db.interviewSession.findFirst({ where: { id: sessionId, orgId, agent: { kind: "TWIN" } }, select: { id: true } });
  if (!session) return;
  const calls = [{ tool: "scenario_examples", input: { situation: input.situation }, output: { examples: input.examples } }];
  await db.twinTurnEvidence.create({
    data: { sessionId, data: { inputKind: TURN_LINES, heard: input.heard, calls } as Prisma.InputJsonValue },
  });
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** What each lookup tool is, in the panel's words, and the query it ran. */
const LOOKUPS: Record<string, { label: string; query: (input: Record<string, unknown>) => string | null }> = {
  scenario_examples: { label: "her sessions", query: (i) => text(i.situation) },
  search_knowledge: { label: "knowledge", query: (i) => text(i.query) },
  read_knowledge_document: { label: "a knowledge document", query: (i) => text(i.documentId) },
  search_style: { label: "her phrasing", query: (i) => text(i.query) },
  read_document: { label: "a document", query: (i) => text(i.documentId) ?? text(i.name) },
  eve__skill: { label: "skill", query: (i) => text(i.name) ?? text(i.skill) },
};

/** The result list a lookup returned (scenario_examples: examples; search tools: results/chunks/hits). */
function found(output: unknown): Record<string, unknown>[] {
  const out = asRecord(output);
  const list = [out.examples, out.results, out.chunks, out.hits, out.pastExchanges].find(Array.isArray);
  return Array.isArray(list) ? list.map(asRecord) : [];
}

export type EvidenceMoment = {
  text: string;
  context: string | null;
  source: { title: string; url: string | null; date: string | null; kind: "video" | "document" } | null;
};
export type TurnEvidence = {
  id: string;
  heard: string;
  reply: string;
  opening: boolean;
  searches: { label: string; query: string | null; found: number }[];
  moments: EvidenceMoment[];
};

/** Evidence of one twin session, oldest first, with each moment's source resolved to its knowledge document. */
export async function sessionEvidence(orgId: string, sessionId: string): Promise<TurnEvidence[]> {
  const rows = await db.twinTurnEvidence.findMany({
    // A deleted call's or an archived twin's evidence answers like none (specs/practice.md rule 15).
    where: { sessionId, session: { orgId, deletedAt: null, agent: { archivedAt: null } } },
    orderBy: { createdAt: "asc" },
    select: { id: true, data: true },
  });
  const turns = rows.filter((row) => asRecord(row.data).inputKind !== TURN_LINES).map((row) => {
    const data = asRecord(row.data);
    const calls = (Array.isArray(data.calls) ? data.calls : []).map(asRecord);
    const lookups = calls.filter((call) => typeof call.tool === "string" && call.tool in LOOKUPS);
    return {
      id: row.id,
      heard: text(data.heard) ?? "",
      reply: text(data.reply) ?? "",
      opening: data.inputKind === "opening",
      searches: lookups.map((call) => {
        const tool = LOOKUPS[call.tool as string];
        return { label: tool.label, query: tool.query(asRecord(call.input)), found: found(call.output).length };
      }),
      hits: lookups.flatMap((call) => found(call.output)),
    };
  });

  // Moments name their source (a knowledge document id, from the twin skill's items).
  const sourceIds = [...new Set(turns.flatMap((turn) => turn.hits.map((hit) => text(hit.source)).filter((id): id is string => !!id)))];
  const docs = sourceIds.length
    ? await db.knowledgeDocument.findMany({
        where: { id: { in: sourceIds }, kb: { orgId } },
        select: { id: true, title: true, slug: true, ext: true, externalId: true, createdAt: true, source: { select: { connector: true, sourceUrl: true } } },
      })
    : [];
  const sources = new Map(docs.map((doc) => {
    const loom = doc.externalId?.startsWith("loom:") ? `https://www.loom.com/share/${doc.externalId.slice(5)}` : null;
    const url = doc.source?.sourceUrl ?? loom;
    const video = doc.source?.connector === "youtube" || !!loom || doc.ext === "mp4";
    return [doc.id, { title: doc.title || doc.slug, url, date: doc.createdAt.toISOString(), kind: video ? ("video" as const) : ("document" as const) }];
  }));

  return turns.map(({ hits, ...turn }) => ({
    ...turn,
    moments: hits
      .map((hit) => ({
        text: text(hit.text) ?? text(hit.content) ?? text(hit.snippet) ?? "",
        context: text(hit.context) ?? text(hit.title) ?? null,
        source: sources.get(text(hit.source) ?? "") ?? null,
      }))
      .filter((moment) => moment.text),
  }));
}
