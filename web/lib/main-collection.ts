import type { Collection, EmbeddingFunction, Where } from "chromadb";
import { ChromaTenantService, isSharedScope } from "@/lib/chroma-tenant";
import { embedTexts } from "@/lib/knowledge";
import type { PersonaVoiceMoment } from "@/lib/persona-voice";

export const openRouterEmbeddings: EmbeddingFunction = {
  generate: embedTexts,
  generateForQueries: embedTexts,
  defaultSpace: () => "cosine",
  supportedSpaces: () => ["cosine"],
};

export type KnowledgeMetadata = {
  type: "knowledge";
  orgId: string;
  kbId: string;
  docId: string;
  source: string;
  title?: string;
  chunkIndex: number;
};

export type PersonaVoiceMetadata = {
  type: "persona_voice" | "persona_voice_episode" | "persona_style_episode";
  orgId: string;
  personaId: string;
  sourceId: string;
  sourceName: string;
  momentIndex: number;
  action?: string;
  learnerState?: string;
  move?: string;
  candidateContext?: string;
  previousInterviewerContext?: string;
  nextCandidateContext?: string;
  sessionContext?: string;
  sessionPhase?: "opening" | "middle" | "closing";
  pastLearnerName?: string;
  styleFunction?: string;
  styleShape?: string;
  styleFeatures?: string;
  usesLearnerName?: boolean;
  startsWithThanks?: boolean;
  hasDoubledAcknowledgement?: boolean;
  questionCount?: number;
  wordCount?: number;
};

export type MainCollectionMetadata = KnowledgeMetadata | PersonaVoiceMetadata;

export class MainCollectionService {
  /**
   * Resolves collection name for the org.
   * - In dedicated mode (self-hosted or enterprise Chroma): "main" (isolated by tenant/database).
   * - In shared mode (standard Chroma Cloud): `org_<orgId>_main` to prevent inter-org collision.
   */
  static getCollectionName(orgId: string, isSharedFallback = false): string {
    return isSharedFallback ? `org_${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}_main` : "main";
  }

  /**
   * Gets or creates the `main` collection for an organization.
   */
  static async getCollection(orgId: string): Promise<Collection> {
    const client = await ChromaTenantService.getClient(orgId);
    const isSharedFallback = isSharedScope(client.database);
    const name = this.getCollectionName(orgId, isSharedFallback);

    return client.getOrCreateCollection({
      name,
      embeddingFunction: openRouterEmbeddings,
      configuration: {
        hnsw: { space: "cosine", ef_construction: 200, ef_search: 200, max_neighbors: 24 },
      },
    });
  }

  /**
   * Ingests knowledge chunks for one document into the organization's main collection.
   * Idempotent per docId.
   */
  static async ingestKnowledgeDoc(
    orgId: string,
    kbId: string,
    docId: string,
    source: string,
    title: string,
    chunks: string[],
  ): Promise<number> {
    const collection = await this.getCollection(orgId);

    // Delete any existing chunks for this document
    try {
      await collection.delete({
        where: {
          $and: [{ type: "knowledge" }, { docId }],
        } as Where,
      });
    } catch {
      // Collection may be new or doc may not exist yet
    }

    if (chunks.length === 0) return 0;

    const embeddings = await embedTexts(chunks);

    for (let i = 0; i < chunks.length; i += 5000) {
      const batchDocs = chunks.slice(i, i + 5000);
      const batchEmbeddings = embeddings.slice(i, i + 5000);
      const batchIds = batchDocs.map((_, j) => `kb_${docId}#${i + j}`);
      const batchMetadatas: KnowledgeMetadata[] = batchDocs.map((_, j) => ({
        type: "knowledge",
        orgId,
        kbId,
        docId,
        source,
        title,
        chunkIndex: i + j,
      }));

      await collection.upsert({
        ids: batchIds,
        embeddings: batchEmbeddings,
        documents: batchDocs,
        metadatas: batchMetadatas,
      });
    }

    return chunks.length;
  }

  /**
   * Removes all knowledge chunks for a document from the organization's main collection.
   */
  static async removeKnowledgeDoc(orgId: string, docId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "knowledge" }, { docId }],
        } as Where,
      });
    } catch {
      // deletion proceeds regardless
    }
  }

  /**
   * Removes all knowledge chunks for an entire knowledge base.
   */
  static async removeKnowledgeBase(orgId: string, kbId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "knowledge" }, { kbId }],
        } as Where,
      });
    } catch {
      // deletion proceeds regardless
    }
  }

  /**
   * Ingests extracted persona voice moments into the organization's main collection.
   * Idempotent per sourceId.
   */
  static async ingestPersonaVoice(
    orgId: string,
    personaId: string,
    sourceId: string,
    sourceName: string,
    moments: Array<string | PersonaVoiceMoment>,
    recordType: "persona_voice" | "persona_voice_episode" | "persona_style_episode" = "persona_voice",
  ): Promise<number> {
    const collection = await this.getCollection(orgId);

    try {
      await collection.delete({
        where: {
          $and: [{ type: recordType }, { sourceId }],
        } as Where,
      });
    } catch {
      // Ignore if not present
    }

    const records: PersonaVoiceMoment[] = moments.map((moment) =>
      typeof moment === "string" ? { text: moment } : moment,
    );
    if (records.length === 0) return 0;

    const embeddings = await embedTexts(records.map((moment) => moment.embeddingText ?? moment.text));

    for (let i = 0; i < records.length; i += 5000) {
      const batchDocs = records.slice(i, i + 5000);
      const batchEmbeddings = embeddings.slice(i, i + 5000);
      const batchIds = batchDocs.map((_, j) => `${recordType}_${sourceId}#${i + j}`);
      const batchMetadatas: PersonaVoiceMetadata[] = batchDocs.map((moment, j) => ({
        type: recordType,
        orgId,
        personaId,
        sourceId,
        sourceName,
        momentIndex: i + j,
        ...(moment.action ? { action: moment.action } : {}),
        ...(moment.learnerState ? { learnerState: moment.learnerState } : {}),
        ...(moment.move ? { move: moment.move } : {}),
        ...(moment.candidateContext ? { candidateContext: moment.candidateContext } : {}),
        ...(moment.previousInterviewerContext ? { previousInterviewerContext: moment.previousInterviewerContext } : {}),
        ...(moment.nextCandidateContext ? { nextCandidateContext: moment.nextCandidateContext } : {}),
        ...(moment.sessionContext ? { sessionContext: moment.sessionContext } : {}),
        ...(moment.sessionPhase ? { sessionPhase: moment.sessionPhase } : {}),
        ...(moment.pastLearnerName ? { pastLearnerName: moment.pastLearnerName } : {}),
        ...(moment.styleFunction ? { styleFunction: moment.styleFunction } : {}),
        ...(moment.styleShape ? { styleShape: moment.styleShape } : {}),
        ...(moment.styleFeatures ? { styleFeatures: moment.styleFeatures } : {}),
        ...(moment.usesLearnerName !== undefined ? { usesLearnerName: moment.usesLearnerName } : {}),
        ...(moment.startsWithThanks !== undefined ? { startsWithThanks: moment.startsWithThanks } : {}),
        ...(moment.hasDoubledAcknowledgement !== undefined ? { hasDoubledAcknowledgement: moment.hasDoubledAcknowledgement } : {}),
        ...(moment.questionCount !== undefined ? { questionCount: moment.questionCount } : {}),
        ...(moment.wordCount !== undefined ? { wordCount: moment.wordCount } : {}),
      }));

      await collection.upsert({
        ids: batchIds,
        embeddings: batchEmbeddings,
        documents: batchDocs.map((moment) => moment.text),
        metadatas: batchMetadatas,
      });
    }

    return records.length;
  }

  /**
   * Removes persona voice moments for one source.
   */
  static async removePersonaSource(orgId: string, sourceId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "persona_voice" }, { sourceId }],
        } as Where,
      });
    } catch {
      // Ignore if not present
    }
  }

  /**
   * Removes all persona voice moments for an entire persona.
   */
  static async removePersona(orgId: string, personaId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "persona_voice" }, { personaId }],
        } as Where,
      });
    } catch {
      // Ignore if not present
    }
  }

  /**
   * Searches knowledge documents in the organization's main collection.
   */
  static async searchKnowledge(
    orgId: string,
    query: string,
    options: { kbIds?: string[]; limit?: number } = {},
  ): Promise<{ id: string; docId: string; kbId: string; source: string; text: string; score: number }[]> {
    const collection = await this.getCollection(orgId);
    const limit = options.limit ?? 5;
    const [queryEmbedding] = await embedTexts([query]);

    let whereFilter: Where = { type: "knowledge" };
    if (options.kbIds && options.kbIds.length === 1) {
      whereFilter = { $and: [{ type: "knowledge" }, { kbId: options.kbIds[0] }] } as Where;
    } else if (options.kbIds && options.kbIds.length > 1) {
      whereFilter = { $and: [{ type: "knowledge" }, { kbId: { $in: options.kbIds } }] } as Where;
    }

    const res = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereFilter,
      include: ["documents", "metadatas", "distances"],
    });

    const hits: { id: string; docId: string; kbId: string; source: string; text: string; score: number }[] = [];
    const ids = res.ids?.[0] ?? [];
    const docs = res.documents?.[0] ?? [];
    const metadatas = (res.metadatas?.[0] ?? []) as Record<string, unknown>[];
    const distances = res.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const meta = metadatas[i] ?? {};
      const dist = distances ? distances[i] : null;
      hits.push({
        id: ids[i],
        docId: String(meta.docId ?? ids[i]),
        kbId: String(meta.kbId ?? ""),
        source: String(meta.source ?? ""),
        text: docs[i] ?? "",
        score: dist !== null && dist !== undefined ? 1 - dist : 0,
      });
    }

    return hits;
  }

  /**
   * Searches persona voice moments in the organization's main collection.
   */
  static async searchPersonaVoice(
    orgId: string,
    query: string,
    options: { personaId?: string; action?: string; learnerState?: string; move?: string; limit?: number } = {},
  ): Promise<{ id: string; personaId: string; sourceId: string; text: string; score: number; action?: string; learnerState?: string; move?: string }[]> {
    const collection = await this.getCollection(orgId);
    const limit = options.limit ?? 4;
    const [queryEmbedding] = await embedTexts([query]);

    const run = async (filters: { action?: string; learnerState?: string; move?: string }) => {
      const conditions: Where[] = [{ type: "persona_voice" }];
      if (options.personaId) conditions.push({ personaId: options.personaId });
      if (filters.action) conditions.push({ action: filters.action });
      if (filters.learnerState) conditions.push({ learnerState: filters.learnerState });
      if (filters.move) conditions.push({ move: filters.move });
      const whereClause: Where = conditions.length > 1 ? ({ $and: conditions } as Where) : conditions[0];
      const res = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: limit,
        where: whereClause,
        include: ["documents", "metadatas", "distances"],
      });
      const hits: { id: string; personaId: string; sourceId: string; text: string; score: number; action?: string; learnerState?: string; move?: string }[] = [];
      const ids = res.ids?.[0] ?? [];
      const docs = res.documents?.[0] ?? [];
      const metadatas = (res.metadatas?.[0] ?? []) as Record<string, unknown>[];
      const distances = res.distances?.[0] ?? [];
      for (let i = 0; i < ids.length; i++) {
        const meta = metadatas[i] ?? {};
        const dist = distances ? distances[i] : null;
        hits.push({
          id: ids[i],
          personaId: String(meta.personaId ?? ""),
          sourceId: String(meta.sourceId ?? ""),
          text: docs[i] ?? "",
          score: dist !== null && dist !== undefined ? 1 - dist : 0,
          action: typeof meta.action === "string" ? meta.action : undefined,
          learnerState: typeof meta.learnerState === "string" ? meta.learnerState : undefined,
          move: typeof meta.move === "string" ? meta.move : undefined,
        });
      }
      return hits;
    };

    const filtered = await run({
      action: options.action,
      learnerState: options.learnerState,
      move: options.move,
    });
    if (filtered.length > 0 || (!options.action && !options.learnerState && !options.move)) return filtered;
    return run({});
  }

  /**
   * Generic persona search across the experimental record types
   * (persona_voice_episode / persona_style_episode).
   * diversify=true over-fetches and keeps at most one record per source
   * conversation so one transcript cannot dominate a result set.
   */
  private static async searchPersonaVoiceType(
    orgId: string,
    query: string,
    recordType: "persona_voice_episode" | "persona_style_episode",
    options: {
      personaId?: string;
      sessionPhase?: string;
      limit?: number;
      diversify?: boolean;
      styleFilters?: { usesLearnerName?: boolean; startsWithThanks?: boolean; hasDoubledAcknowledgement?: boolean };
    } = {},
  ): Promise<{
    id: string;
    personaId: string;
    sourceId: string;
    sourceName: string;
    text: string;
    score: number;
    sessionPhase?: string;
    pastLearnerName?: string;
    styleFunction?: string;
    styleShape?: string;
    usesLearnerName?: boolean;
    startsWithThanks?: boolean;
    hasDoubledAcknowledgement?: boolean;
  }[]> {
    const collection = await this.getCollection(orgId);
    const limit = options.limit ?? 4;
    const conditions: Where[] = [{ type: recordType }];
    if (options.personaId) conditions.push({ personaId: options.personaId });
    if (options.sessionPhase) conditions.push({ sessionPhase: options.sessionPhase });
    if (options.styleFilters?.usesLearnerName !== undefined) {
      conditions.push({ usesLearnerName: options.styleFilters.usesLearnerName });
    }
    if (options.styleFilters?.startsWithThanks !== undefined) {
      conditions.push({ startsWithThanks: options.styleFilters.startsWithThanks });
    }
    if (options.styleFilters?.hasDoubledAcknowledgement !== undefined) {
      conditions.push({ hasDoubledAcknowledgement: options.styleFilters.hasDoubledAcknowledgement });
    }
    const whereClause: Where = conditions.length > 1 ? ({ $and: conditions } as Where) : conditions[0];
    const res = await collection.query({
      queryEmbeddings: await embedTexts([query]),
      nResults: options.diversify ? limit * 3 : limit,
      where: whereClause,
      include: ["documents", "metadatas", "distances"],
    });
    const ids = res.ids?.[0] ?? [];
    const docs = res.documents?.[0] ?? [];
    const metadatas = (res.metadatas?.[0] ?? []) as Record<string, unknown>[];
    const distances = res.distances?.[0] ?? [];
    const hits: Array<Record<string, unknown>> = [];
    const seenSources = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      const meta = metadatas[i] ?? {};
      if (options.diversify) {
        const source = String(meta.sourceId ?? ids[i]);
        if (seenSources.has(source)) continue;
        seenSources.add(source);
      }
      const dist = distances ? distances[i] : null;
      hits.push({
        id: ids[i],
        personaId: String(meta.personaId ?? ""),
        sourceId: String(meta.sourceId ?? ""),
        sourceName: String(meta.sourceName ?? ""),
        text: docs[i] ?? "",
        score: dist !== null && dist !== undefined ? 1 - dist : 0,
        ...(typeof meta.sessionPhase === "string" ? { sessionPhase: meta.sessionPhase } : {}),
        ...(typeof meta.pastLearnerName === "string" ? { pastLearnerName: meta.pastLearnerName } : {}),
        ...(typeof meta.styleFunction === "string" ? { styleFunction: meta.styleFunction } : {}),
        ...(typeof meta.styleShape === "string" ? { styleShape: meta.styleShape } : {}),
        ...(meta.usesLearnerName !== undefined ? { usesLearnerName: meta.usesLearnerName === true } : {}),
        ...(meta.startsWithThanks !== undefined ? { startsWithThanks: meta.startsWithThanks === true } : {}),
        ...(meta.hasDoubledAcknowledgement !== undefined ? { hasDoubledAcknowledgement: meta.hasDoubledAcknowledgement === true } : {}),
      });
      if (hits.length >= limit) break;
    }
    return hits as never;
  }

  /** Searches situation episodes (full labelled conversation exchanges). */
  static async searchPersonaEpisodes(
    orgId: string,
    query: string,
    options: { personaId?: string; sessionPhase?: string; limit?: number; diversify?: boolean } = {},
  ) {
    return this.searchPersonaVoiceType(orgId, query, "persona_voice_episode", options);
  }

  /** Searches topic-neutral style records for the bounded speech renderer. */
  static async searchStyleEpisodes(
    orgId: string,
    query: string,
    options: {
      personaId?: string;
      sessionPhase?: string;
      limit?: number;
      diversify?: boolean;
      styleFilters?: { usesLearnerName?: boolean; startsWithThanks?: boolean; hasDoubledAcknowledgement?: boolean };
    } = {},
  ) {
    return this.searchPersonaVoiceType(orgId, query, "persona_style_episode", options);
  }

  /**
   * Mechanical corpus statistics over situation episodes, used for the
   * session primer and style drift comparison. Cached per persona for the
   * process lifetime: stats only change when a reindex runs (new deploy).
   */
  static async getPersonaPrimerStats(
    orgId: string,
    personaId: string,
  ): Promise<{
    turns: number;
    learner_name_use_rate: number;
    doubled_acknowledgement_rate: number;
    thanks_turn_start_rate: number;
    average_spoken_words: number;
    average_questions: number;
  }> {
    const cacheKey = `${orgId}:${personaId}`;
    const cached = primerStatsCache.get(cacheKey);
    if (cached) return cached;

    const collection = await this.getCollection(orgId);
    const entries: Array<{ name: string; response: string }> = [];
    for (let offset = 0; offset < 1200; offset += 300) {
      const page = await collection.get({
        where: { $and: [{ type: "persona_voice_episode" }, { personaId }] } as Where,
        limit: 300,
        offset,
        include: ["documents", "metadatas"],
      });
      const docs = page.documents ?? [];
      const metas = (page.metadatas ?? []) as Record<string, unknown>[];
      for (let i = 0; i < docs.length; i++) {
        const response = String(docs[i] ?? "").split("\nVasanth: ")[1]?.split("\nPast learner reaction:")[0];
        if (!response) continue;
        entries.push({
          name: typeof metas[i]?.pastLearnerName === "string" ? (metas[i].pastLearnerName as string) : "",
          response,
        });
      }
      if (docs.length < 300) break;
    }
    const doubledRe = /\b(yes|yeah|correct|right|good|okay|sure|no)[,. ]+\1\b/i;
    const words = (response: string) => response.trim().split(/\s+/).filter(Boolean).length;
    const rate = (predicate: (entry: { name: string; response: string }) => boolean) =>
      entries.length ? entries.filter(predicate).length / entries.length : 0;
    const escapeRe = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stats = {
      turns: entries.length,
      learner_name_use_rate: rate(({ name, response }) =>
        Boolean(name && new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(response))),
      doubled_acknowledgement_rate: rate(({ response }) => doubledRe.test(response)),
      thanks_turn_start_rate: rate(({ response }) => /^(thanks|thank you)\b/i.test(response)),
      average_spoken_words: entries.length
        ? entries.reduce((sum, { response }) => sum + words(response), 0) / entries.length
        : 0,
      average_questions: entries.length
        ? entries.reduce((sum, { response }) => sum + (response.match(/\?/g)?.length ?? 0), 0) / entries.length
        : 0,
    };
    primerStatsCache.set(cacheKey, stats);
    return stats;
  }
}

const primerStatsCache = new Map<string, {
  turns: number;
  learner_name_use_rate: number;
  doubled_acknowledgement_rate: number;
  thanks_turn_start_rate: number;
  average_spoken_words: number;
  average_questions: number;
}>();
