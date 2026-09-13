import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { handleCompletions } from "@/lib/runtime/openai";
import { MainCollectionService } from "@/lib/main-collection";
import { getAgentConfigForAgent } from "@/lib/specs";

const AGENT_SLUG = process.env.BENCH_AGENT_SLUG ?? "project-experience-deep-dive";
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

type Event = {
  stage: string;
  kind: "db" | "llm" | "embedding" | "chroma" | "retrieval" | "rerank";
  startMs: number;
  endMs: number;
  ms: number;
  meta?: Record<string, unknown>;
};

type Turn = {
  label: string;
  wallMs: number;
  status: number;
  response: string;
  events: Event[];
  telemetry?: Record<string, unknown>;
  logs: Array<{ message: string; data?: unknown }>;
};

let turnStart: number | null = null;
let events: Event[] = [];
let logs: Turn["logs"] = [];
let completionTelemetry: Record<string, unknown> | undefined;
const now = () => performance.now();
const offset = (value: number) => Math.round(value - (turnStart ?? value));
const record = (stage: Event["stage"], kind: Event["kind"], start: number, end: number, meta?: Event["meta"]) => {
  if (turnStart === null) return;
  events.push({ stage, kind, startMs: offset(start), endMs: offset(end), ms: Math.round(end - start), ...(meta ? { meta } : {}) });
};

const classifyLlm = (body: Record<string, any>) => {
  const system = String(body.messages?.find((message: any) => message.role === "system")?.content ?? "");
  if (system.includes("conversation controller")) return "direction";
  if (system.includes("technical interviewer evaluator")) return "analysis";
  if (system.includes("preparing the CONTENT")) return "content";
  if (system.includes("prepare a retrieval query")) return "style_gate";
  if (system.includes("bounded speech renderer")) return "renderer";
  return "unknown_llm";
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : {};
  const isLlm = url.includes("/chat/completions");
  const isEmbedding = url.includes("/embeddings");
  const isRerank = url.includes("/rerank");
  const stage = isLlm ? classifyLlm(body) : isEmbedding ? "embedding" : isRerank ? "reranker" : "";
  const start = now();
  try {
    const response = await realFetch(input, init);
    const headersAt = now();
    const payload = stage
      ? await response.clone().json().catch(() => null) as Record<string, any> | null
      : null;
    const end = now();
    if (stage) {
      record(stage, isLlm ? "llm" : isEmbedding ? "embedding" : "rerank", start, end, {
        status: response.status,
        headersMs: Math.round(headersAt - start),
        model: body.model,
        requestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0,
        ...(isRerank ? {
          candidates: body.documents?.length ?? 0,
          results: payload?.results?.length ?? 0,
          ranking: payload?.results ?? [],
        } : {}),
        ...(isLlm && payload?.usage ? { usage: payload.usage } : {}),
      });
    }
    return response;
  } catch (error) {
    const end = now();
    if (stage) record(stage, isLlm ? "llm" : isEmbedding ? "embedding" : "rerank", start, end, { error: String(error) });
    throw error;
  }
}) as typeof fetch;

const wrappedCollections = new WeakSet<object>();
const originalGetCollection = MainCollectionService.getCollection.bind(MainCollectionService);
MainCollectionService.getCollection = (async (orgId: string) => {
  const start = now();
  const collection = await originalGetCollection(orgId);
  const end = now();
  record("chroma.collection", "chroma", start, end);
  if (!wrappedCollections.has(collection)) {
    wrappedCollections.add(collection);
    const query = collection.query.bind(collection);
    collection.query = (async (args: any) => {
      const type = JSON.stringify(args.where ?? {}).match(/persona_style_episode|persona_voice_episode|knowledge/)?.[0] ?? "unknown";
      const start = now();
      try {
        const result = await query(args);
        record(`chroma.query.${type}`, "chroma", start, now(), { hits: result.ids?.[0]?.length ?? 0, nResults: args.nResults });
        return result;
      } catch (error) {
        record(`chroma.query.${type}`, "chroma", start, now(), { error: String(error) });
        throw error;
      }
    }) as typeof collection.query;
    const get = collection.get.bind(collection);
    collection.get = (async (args?: any) => {
      const type = JSON.stringify(args?.where ?? {}).match(/persona_style_episode|persona_voice_episode|knowledge/)?.[0] ?? "unknown";
      const start = now();
      try {
        const result = await get(args);
        record(`chroma.get.${type}`, "chroma", start, now(), { rows: result.ids?.length ?? 0, offset: args?.offset ?? 0 });
        return result;
      } catch (error) {
        record(`chroma.get.${type}`, "chroma", start, now(), { error: String(error) });
        throw error;
      }
    }) as typeof collection.get;
  }
  return collection;
}) as typeof MainCollectionService.getCollection;

function wrapRetrieval(method: "searchKnowledge" | "searchPersonaEpisodes" | "searchStyleEpisodes" | "getPersonaPrimerStats", stage: string) {
  const original = (MainCollectionService[method] as any).bind(MainCollectionService);
  (MainCollectionService[method] as any) = async (...args: unknown[]) => {
    const start = now();
    try {
      const result = await original(...args);
      record(stage, "retrieval", start, now(), {
        hits: Array.isArray(result) ? result.length : (result as any)?.turns,
        ...(Array.isArray(result) ? {
          records: result.slice(0, stage === "knowledge.search" ? 20 : 5).map((hit: any) => ({
            id: hit.id,
            source: hit.source ?? hit.sourceName,
            score: hit.score,
            text: String(hit.text ?? "").slice(0, 600),
          })),
        } : {}),
      });
      return result;
    } catch (error) {
      record(stage, "retrieval", start, now(), { error: String(error) });
      throw error;
    }
  };
}
wrapRetrieval("searchKnowledge", "knowledge.search");
wrapRetrieval("searchPersonaEpisodes", "persona.episodes");
wrapRetrieval("searchStyleEpisodes", "persona.style");
wrapRetrieval("getPersonaPrimerStats", "persona.primer");

function wrapDb(model: any, method: string, stage: string) {
  const original = model[method].bind(model);
  model[method] = async (...args: unknown[]) => {
    const start = now();
    const result = await original(...args);
    const end = now();
    record(stage, "db", start, end);
    return result;
  };
}
wrapDb(db.interviewSession, "findFirst", "db.auth");
wrapDb(db.interviewSession, "update", "db.persist");
wrapDb(db.knowledgeBase, "findMany", "db.knowledge_bases");

const realInfo = console.info;
console.info = ((message?: unknown, data?: unknown, ...rest: unknown[]) => {
  if (turnStart !== null && typeof message === "string" && message.startsWith("[interview-runtime]")) {
    logs.push({ message, data });
    if (message.endsWith("completion served") && data && typeof data === "object") {
      completionTelemetry = data as Record<string, unknown>;
    }
  }
  realInfo(message, data, ...rest);
}) as typeof console.info;

async function runTurn(label: string, token: string, messages: Array<Record<string, unknown>>): Promise<Turn> {
  events = [];
  logs = [];
  completionTelemetry = undefined;
  turnStart = now();
  const response = await handleCompletions(new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "trainertwin-runtime", messages, stream: false }),
  }));
  const payload = await response.json() as any;
  const wallMs = Math.round(now() - turnStart);
  turnStart = null;
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(payload)}`);
  return {
    label,
    wallMs,
    status: response.status,
    response: String(payload.choices?.[0]?.message?.content ?? "[tool call]"),
    events: [...events].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
    ...(completionTelemetry ? { telemetry: completionTelemetry } : {}),
    logs: [...logs],
  };
}

const agent = await db.agent.findFirstOrThrow({
  where: { slug: AGENT_SLUG },
  include: { persona: true },
});
const member = await db.member.findFirstOrThrow({ where: { organizationId: agent.orgId } });
const context = await db.contextDocument.findFirst({
  where: { orgId: agent.orgId },
  orderBy: { createdAt: "desc" },
});
const config = await getAgentConfigForAgent(agent.id, agent.orgId, context?.id);
if (!config) throw new Error("Could not compile the real agent configuration");

const token = `bench-${randomBytes(18).toString("hex")}`;
const sessionId = `bench-${randomBytes(8).toString("hex")}`;
await db.interviewSession.create({
  data: {
    id: sessionId,
    orgId: agent.orgId,
    userId: member.userId,
    agentId: agent.id,
    contextId: context?.id,
    contextName: context?.name,
    shareCode: randomBytes(9).toString("hex"),
    runtimeTokenHash: tokenHash(token),
    personaSlug: agent.persona.slug,
    personaVersion: agent.persona.version,
    agentSlug: agent.slug,
    agentVersion: agent.version,
    domainSlug: agent.domainSlug,
    domainVersion: 1,
    status: "active",
    compiledSnapshot: config,
    runtimeState: {},
    runtimeRevision: 0,
  },
});

const turns: Turn[] = [];
try {
  turns.push(await runTurn("opening", token, [{ role: "developer", content: "session-start" }]));
  turns.push(await runTurn("ownership-answer", token, [{ role: "user", content: "I personally designed and led the migration of our order-processing monolith into event-driven services. I owned the architecture, broke the work into milestones, and reviewed the implementation from five engineers." }]));
  turns.push(await runTurn("mechanism-answer", token, [{ role: "user", content: "We used Kafka with an outbox pattern so database writes and emitted events stayed consistent. Consumers were idempotent using the order ID, and we used dead-letter queues with replay tooling for failures." }]));
  turns.push(await runTurn("impact-answer", token, [{ role: "user", content: "After rollout, deployment time fell from 40 minutes to 8 minutes, order-processing failures dropped by 35 percent, and the team moved from weekly releases to daily releases." }]));
  turns.push(await runTurn("repeat-request", token, [{ role: "user", content: "Sorry, can you repeat the question?" }]));
} finally {
  await db.interviewSession.deleteMany({ where: { id: sessionId } });
}

const output = {
  generatedAt: new Date().toISOString(),
  environment: {
    model: process.env.INTERVIEW_LLM_MODEL ?? "openai/gpt-4.1-mini",
    reranker: process.env.RERANK_ENABLED === "1" ? (process.env.RERANK_MODEL ?? "cohere/rerank-v3.5") : null,
    agent: { id: agent.id, slug: agent.slug },
    persona: { id: agent.persona.id, slug: agent.persona.slug },
    context: context ? { id: context.id, name: context.name } : null,
    knowledgeBases: config.knowledgeBases,
    personaVoiceAvailable: config.personaVoiceAvailable,
    stream: false,
  },
  turns,
};
const outputFile = process.env.BENCH_OUTPUT ?? "bench-results.json";
await Bun.write(new URL(`./${outputFile}`, import.meta.url), JSON.stringify(output, null, 2));

const topLevel = new Set(["db.auth", "db.knowledge_bases", "knowledge.search", "reranker", "persona.primer", "persona.episodes", "direction", "analysis", "content", "style_gate", "persona.style", "renderer", "db.persist"]);
for (const turn of turns) {
  console.log(`\n${turn.label}: ${turn.wallMs}ms`);
  for (const event of turn.events.filter((event) => topLevel.has(event.stage))) {
    console.log(`  ${event.stage.padEnd(22)} ${String(event.ms).padStart(5)}ms  (${event.startMs} → ${event.endMs})`);
  }
  console.log(`  response: ${turn.response.slice(0, 180)}`);
}
console.log(`\nSaved web/scripts/${outputFile}`);
