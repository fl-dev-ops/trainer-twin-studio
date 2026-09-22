import { createGateway, embed } from "ai";
import { studioFetch } from "./studio";

export type LocalStyleHit = {
  id: string;
  sourceId: string;
  text: string;
  score: number;
  metadata: {
    sessionPhase?: string;
    styleFunction?: string;
    styleShape?: string;
    usesLearnerName?: boolean;
    startsWithThanks?: boolean;
    hasDoubledAcknowledgement?: boolean;
  };
};

type SerializedMoment = {
  id: string;
  sourceId: string;
  sourceName?: string;
  text: string;
  int8EmbeddingB64: string;
  sessionPhase?: string;
  pastLearnerName?: string;
  styleFunction?: string;
  styleShape?: string;
  usesLearnerName?: boolean;
  startsWithThanks?: boolean;
  hasDoubledAcknowledgement?: boolean;
};

type CachedLocalRecord = {
  id: string;
  sourceId: string;
  text: string;
  embedding: Float32Array;
  sessionPhase?: string;
  pastLearnerName?: string;
  styleFunction?: string;
  styleShape?: string;
  usesLearnerName?: boolean;
  startsWithThanks?: boolean;
  hasDoubledAcknowledgement?: boolean;
};

const localPersonaCache = new Map<string, Promise<CachedLocalRecord[]>>();

function redactName(text: string, name?: string): string {
  if (!text || !name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "<name>");
}

async function loadPersonaStyleMoments(orgId: string, personaSlug: string): Promise<CachedLocalRecord[]> {
  const result = await studioFetch<{
    personaSlug: string;
    personaName: string;
    moments: SerializedMoment[];
  }>(orgId, {
    action: "getPersonaStyleMoments",
    personaSlug,
  });

  const records: CachedLocalRecord[] = [];
  for (const m of result.moments ?? []) {
    if (!m.int8EmbeddingB64) continue;
    const buf = Buffer.from(m.int8EmbeddingB64, "base64");
    const int8 = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const f32 = new Float32Array(int8.length);
    for (let j = 0; j < int8.length; j++) f32[j] = int8[j] / 127;

    records.push({
      id: m.id,
      sourceId: m.sourceId,
      text: m.text,
      embedding: f32,
      sessionPhase: m.sessionPhase,
      pastLearnerName: m.pastLearnerName,
      styleFunction: m.styleFunction,
      styleShape: m.styleShape,
      usesLearnerName: m.usesLearnerName,
      startsWithThanks: m.startsWithThanks,
      hasDoubledAcknowledgement: m.hasDoubledAcknowledgement,
    });
  }
  return records;
}

const gateway = createGateway();

/**
 * Executes high-speed local vector search directly inside the Eve process:
 * 1. Direct query embedding via Vercel AI Gateway (~200ms)
 * 2. In-memory dot-product across 743 cached style vectors in RAM (~6ms)
 * 3. Zero cross-service network calls to dash.trainertwin.com during turn execution
 */
export async function searchPersonaStyleLocally(
  orgId: string,
  personaSlug: string,
  query: string,
  limit = 5,
): Promise<{ query: string; results: LocalStyleHit[] }> {
  const cacheKey = `${orgId}:${personaSlug.toLowerCase()}`;
  let recordsPromise = localPersonaCache.get(cacheKey);
  if (!recordsPromise) {
    recordsPromise = loadPersonaStyleMoments(orgId, personaSlug);
    localPersonaCache.set(cacheKey, recordsPromise);
  }
  const records = await recordsPromise;

  if (records.length === 0) {
    return { query, results: [] };
  }

  // 1. Embed query directly
  const res = await embed({
    model: gateway.textEmbeddingModel("openai/text-embedding-3-small"),
    value: query,
  });
  const qVec = new Float32Array(res.embedding);

  // 2. In-memory dot product (~6ms in RAM)
  const scored: { r: CachedLocalRecord; score: number }[] = [];
  for (const r of records) {
    let dot = 0;
    for (let j = 0; j < qVec.length; j++) dot += qVec[j] * r.embedding[j];
    scored.push({ r, score: dot });
  }

  scored.sort((a, b) => b.score - a.score);

  // 3. Diversify across distinct source transcripts
  const hits: LocalStyleHit[] = [];
  const seenSources = new Set<string>();

  for (const { r, score } of scored) {
    if (seenSources.has(r.sourceId)) continue;
    seenSources.add(r.sourceId);

    const pastName = r.pastLearnerName;
    hits.push({
      id: r.id,
      sourceId: r.sourceId,
      text: redactName(r.text, pastName),
      score,
      metadata: {
        sessionPhase: r.sessionPhase,
        styleFunction: redactName(r.styleFunction ?? "", pastName),
        styleShape: redactName(r.styleShape ?? "", pastName),
        usesLearnerName: r.usesLearnerName,
        startsWithThanks: r.startsWithThanks,
        hasDoubledAcknowledgement: r.hasDoubledAcknowledgement,
      },
    });

    if (hits.length >= limit) break;
  }

  return { query, results: hits };
}
