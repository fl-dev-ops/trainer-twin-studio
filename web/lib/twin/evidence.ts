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
  // Tool outputs can be long: keep the row bounded (calls are dropped, heard/reply stay).
  const fits = JSON.stringify(data).length <= MAX_EVIDENCE_BYTES;
  await db.twinTurnEvidence.create({
    data: { sessionId, data: (fits ? data : { ...data, calls: [], truncated: true }) as Prisma.InputJsonValue },
  });
  return { stored: true };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** What each lookup tool is, in the panel's words, and the query it ran. */
const LOOKUPS: Record<string, { label: string; query: (input: Record<string, unknown>) => string | null }> = {
  scenario_examples: { label: "her sessions", query: (i) => text(i.situation) },
  search_knowledge: { label: "knowledge", query: (i) => text(i.query) },
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
    where: { sessionId, session: { orgId } },
    orderBy: { createdAt: "asc" },
    select: { id: true, data: true },
  });
  const turns = rows.map((row) => {
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
