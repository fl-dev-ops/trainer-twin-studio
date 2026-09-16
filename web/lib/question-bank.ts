import type { Collection, EmbeddingFunction, Where } from "chromadb";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db } from "@/lib/db";
import { embedTexts } from "@/lib/knowledge";
import { INTERVIEW_QUESTION_COLLECTION, parseInterviewQuestionRecord, type InterviewQuestionRecord } from "@shared/interview-question";
import { QUESTION_TYPE_ORDER, type QuestionType } from "@shared/interview-question-types";
import type { TechnicalInterviewConfig } from "@/lib/interview-config-schema";
import type { RuntimeState } from "@/lib/runtime/runtime";

const collectionCache = new Map<string, Promise<Collection>>();
const embeddingFunction: EmbeddingFunction = {
  generate: embedTexts,
  generateForQueries: embedTexts,
  defaultSpace: () => "cosine",
  supportedSpaces: () => ["cosine"],
};

async function questionsCollection(orgId: string) {
  let collection = collectionCache.get(orgId);
  if (!collection) {
    collection = ChromaTenantService.getClient(orgId).then((client) => client.getCollection({
      name: INTERVIEW_QUESTION_COLLECTION,
      embeddingFunction,
    }));
    collectionCache.set(orgId, collection);
    void collection.catch(() => collectionCache.delete(orgId));
  }
  return collection;
}

async function resolveKnowledgeBaseIds(orgId: string, references: string[]): Promise<string[]> {
  if (!references.length) return [];
  const rows = await db.knowledgeBase.findMany({
    where: { orgId, OR: [{ id: { in: references } }, { slug: { in: references } }] },
    select: { id: true },
  });
  return rows.map(({ id }) => id);
}

function knowledgeBaseFilter(kbIds: string[]): Where {
  return kbIds.length === 1 ? { kbId: kbIds[0] } as Where : { kbId: { $in: kbIds } } as Where;
}

function searchFilter(input: {
  orgId: string;
  kbIds: string[];
  requiredType: QuestionType;
  topicSlugs?: string[];
}): Where {
  const conditions: Where[] = [
    { orgId: input.orgId } as Where,
    knowledgeBaseFilter(input.kbIds),
    { question_type: input.requiredType } as Where,
  ];
  const topicFilters = input.topicSlugs?.length
    ? [{ topics: { $in: input.topicSlugs } } as Where]
    : [];
  if (topicFilters.length) conditions.push(topicFilters.length === 1 ? topicFilters[0] : { $or: topicFilters } as Where);
  return { $and: conditions } as Where;
}

export type QuestionInventoryInsufficient = {
  kind: "question_inventory_insufficient";
  requiredType: QuestionType;
};

export type QuestionSearchInput = {
  orgId: string;
  knowledgeBaseSlugs: string[];
  requiredType: QuestionType;
  topicSlugs: string[];
  semanticQuery: string;
  excludeQuestionIds?: string[];
  limit: number;
  difficultyOrder?: Array<InterviewQuestionRecord["difficulty"]>;
};

export class QuestionBank {
  static async listTopicSlugs(orgId: string, knowledgeBaseSlugs: string[]): Promise<string[]> {
    try {
      const kbIds = await resolveKnowledgeBaseIds(orgId, knowledgeBaseSlugs);
      if (!kbIds.length) return [];
      const collection = await questionsCollection(orgId);
      const topics = new Set<string>();
      const pageSize = 250;
      for (let offset = 0; ; offset += pageSize) {
        const page = await collection.get({
          where: { $and: [{ orgId }, knowledgeBaseFilter(kbIds)] } as Where,
          limit: pageSize,
          offset,
          include: ["metadatas"],
        });
        const metadatas = (page.metadatas ?? []) as Record<string, unknown>[];
        for (const metadata of metadatas) {
          const raw = metadata.record_json;
          try {
            const record = parseInterviewQuestionRecord(typeof raw === "string" ? JSON.parse(raw) : raw);
            record.topicSlugs.forEach((topic) => topics.add(topic));
          } catch {
            // Malformed records are excluded from authoring just as they are from runtime selection.
          }
        }
        if ((page.ids?.length ?? 0) < pageSize) break;
      }
      return [...topics].sort((left, right) => left.localeCompare(right));
    } catch (error) {
      console.warn(`[DB:question-bank] topic-inventory-failed error=${error instanceof Error ? error.name : "UnknownError"}`);
      return [];
    }
  }

  static async getById(orgId: string, knowledgeBaseSlugs: string[], id: string): Promise<InterviewQuestionRecord | null> {
    try {
      const kbIds = await resolveKnowledgeBaseIds(orgId, knowledgeBaseSlugs);
      if (!kbIds.length) return null;
      const collection = await questionsCollection(orgId);
      const result = await collection.get({
        ids: [id],
        where: { $and: [{ orgId }, knowledgeBaseFilter(kbIds)] } as Where,
        include: ["metadatas"],
      });
      if (!result.ids?.length) return null;
      const raw = (result.metadatas?.[0] as Record<string, unknown> | undefined)?.record_json;
      return parseInterviewQuestionRecord(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch (error) {
      console.warn(`[DB:question-bank] evaluator-lookup-failed error=${error instanceof Error ? error.name : "UnknownError"}`);
    }
    return null;
  }

  static async search(input: QuestionSearchInput): Promise<InterviewQuestionRecord[]> {
    const startedAt = Date.now();
    console.info("[DB:question-bank] start", {
      knowledgeBases: input.knowledgeBaseSlugs,
      questionType: input.requiredType,
      configuredTopics: input.topicSlugs,
      excludedQuestionCount: input.excludeQuestionIds?.length ?? 0,
      limit: input.limit,
    });
    try {
      const kbIds = await resolveKnowledgeBaseIds(input.orgId, input.knowledgeBaseSlugs);
      if (!kbIds.length || !input.topicSlugs.length) {
        console.info(`[DB:question-bank] complete exactHits=0 semanticHits=0 returnedHits=0 elapsedMs=${Date.now() - startedAt}`);
        return [];
      }
      const excluded = new Set(input.excludeQuestionIds ?? []);
      const selectedTopics = new Set(input.topicSlugs);
      const records: Array<{ record: InterviewQuestionRecord; exact: boolean; distance: number }> = [];
      const collection = await questionsCollection(input.orgId);
      const exactWhere = searchFilter({
        orgId: input.orgId,
        kbIds,
        requiredType: input.requiredType,
        topicSlugs: input.topicSlugs,
      });
      const inventoryPageSize = 250;
      for (let offset = 0; ; offset += inventoryPageSize) {
          const inventory = await collection.get({
          where: exactWhere,
          limit: inventoryPageSize,
          offset,
          include: ["metadatas"],
        });
        const inventoryIds = inventory.ids ?? [];
        const inventoryMetadatas = (inventory.metadatas ?? []) as Record<string, unknown>[];
        for (let index = 0; index < inventoryIds.length; index++) {
          try {
            const raw = inventoryMetadatas[index]?.record_json;
            const record = parseInterviewQuestionRecord(typeof raw === "string" ? JSON.parse(raw) : raw);
            if (record.questionType !== input.requiredType || excluded.has(record.id)
              || !record.topicSlugs.some((topic) => selectedTopics.has(topic))) continue;
            records.push({ record, exact: true, distance: -1 });
          } catch {
            // Ignore malformed records at the retrieval boundary.
          }
        }
        if (inventoryIds.length < inventoryPageSize) break;
      }
      if (records.length < input.limit) {
        const [queryEmbedding] = await embedTexts([input.semanticQuery]);
        const semanticWhere = searchFilter({
          orgId: input.orgId,
          kbIds,
          requiredType: input.requiredType,
        });
        const result = await collection.query({
          queryEmbeddings: [queryEmbedding],
          nResults: Math.max(input.limit * 8, 24),
          where: semanticWhere,
          include: ["metadatas", "distances"],
        });
        const ids = result.ids?.[0] ?? [];
        const metadatas = (result.metadatas?.[0] ?? []) as Record<string, unknown>[];
        const distances = result.distances?.[0] ?? [];
        for (let index = 0; index < ids.length; index++) {
          if (excluded.has(ids[index])) continue;
          try {
            const raw = metadatas[index]?.record_json;
            const record = parseInterviewQuestionRecord(typeof raw === "string" ? JSON.parse(raw) : raw);
            if (record.questionType !== input.requiredType || excluded.has(record.id)) continue;
            if (records.some(({ record: existing }) => existing.id === record.id)) continue;
            records.push({
              record,
              exact: false,
              distance: Number(distances[index] ?? 1),
            });
          } catch {
            // Malformed server-side inventory is ignored; generation logs own validation failures.
          }
        }
      }
      const difficultyOrder = input.difficultyOrder ?? ["easy", "medium", "hard"];
      records.sort((left, right) => Number(right.exact) - Number(left.exact)
        || difficultyOrder.indexOf(left.record.difficulty) - difficultyOrder.indexOf(right.record.difficulty)
        || left.distance - right.distance || left.record.id.localeCompare(right.record.id));
      const distinct = [...new Map(records.map((entry) => [entry.record.id, entry])).values()].slice(0, input.limit);
      console.info("[DB:question-bank] complete", {
        questionType: input.requiredType,
        configuredTopics: input.topicSlugs,
        exactHits: records.filter(({ exact }) => exact).length,
        semanticHits: records.filter(({ exact }) => !exact).length,
        returnedHits: distinct.length,
        questions: distinct.map(({ record, exact }) => ({
          id: record.id,
          type: record.questionType,
          difficulty: record.difficulty,
          topics: record.topicSlugs,
          retrieval: exact ? "exact-topic" : "semantic-fallback",
          preview: record.text.replace(/\s+/g, " ").trim().slice(0, 240),
        })),
        elapsedMs: Date.now() - startedAt,
      });
      return distinct.map(({ record }) => record);
    } catch (error) {
      console.error(`[DB:question-bank] failed error=${error instanceof Error ? error.name : "UnknownError"} elapsedMs=${Date.now() - startedAt}`);
      throw error;
    }
  }
}

export async function selectNextTechnicalQuestion(input: {
  orgId: string;
  knowledgeBaseSlugs: string[];
  config: TechnicalInterviewConfig;
  state: RuntimeState;
  stageObjective: string;
  latestCandidateAnswer?: string;
}): Promise<InterviewQuestionRecord | QuestionInventoryInsufficient | null> {
  const counts = input.state.asked_question_counts ?? {};
  const requiredType = QUESTION_TYPE_ORDER.find((type) => (counts[type] ?? 0) < (input.config.question_counts[type] ?? 0));
  if (!requiredType) return null;
  const query = [input.config.topic_slugs.join(" "), input.stageObjective, input.state.current_topic, input.latestCandidateAnswer]
    .filter(Boolean).join("; ");
  const [question] = await QuestionBank.search({
    orgId: input.orgId,
    knowledgeBaseSlugs: input.knowledgeBaseSlugs,
    requiredType,
    topicSlugs: input.config.topic_slugs,
    semanticQuery: query,
    excludeQuestionIds: input.state.used_question_ids,
    limit: 1,
    difficultyOrder: /depth|application|debug|performance|architecture/i.test(input.stageObjective)
      ? ["hard", "medium", "easy"]
      : /concept|mental model|how|why/i.test(input.stageObjective)
        ? ["medium", "easy", "hard"]
        : ["easy", "medium", "hard"],
  });
  if (!question) return { kind: "question_inventory_insufficient", requiredType };
  input.state.used_question_ids = [...(input.state.used_question_ids ?? []), question.id];
  input.state.asked_question_counts = { ...counts, [requiredType]: (counts[requiredType] ?? 0) + 1 };
  input.state.current_main_question = { id: question.id, type: requiredType, topicSlugs: question.topicSlugs };
  input.state.follow_ups_used_for_main = 0;
  return question;
}
