import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

// Raw physical units only. Pricing/credits are derived from these later.
export const USAGE_METRICS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "embedding_tokens",
  "stt_seconds",
  "tts_characters",
  "tts_seconds",
  "connected_seconds",
  "cost_usd", // provider-reported cost, reference only
] as const;

export const USAGE_SOURCES = [
  "voice_agent",
  "chat",
  "copilot",
  "runtime",
  "report",
  "synthesis",
  "spec",
  "rerank",
  "evaluate",
  "resume_claims", // claim extraction at upload + claim selection in session
  "persona_analysis", // Gemini source analysis (video/audio/docs)
  "ingestion", // knowledge embeddings, topic + question generation (org-level)
] as const;

const label = z.string().trim().min(1).max(200);
const item = z.object({
  provider: label,
  model: label,
  metric: z.enum(USAGE_METRICS),
  value: z.number().finite().nonnegative(),
}).strict();
const meta = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 4_000, "meta too large");

export const usageInputSchema = z.discriminatedUnion("kind", [
  // One finished call (LLM step, report, …): quantities are increments.
  z.object({
    kind: z.literal("delta"),
    source: z.enum(USAGE_SOURCES),
    idempotencyKey: label,
    sessionId: label.optional(),
    orgId: label.optional(),
    userId: label.optional(),
    items: z.array(item).min(1).max(50),
    meta: meta.optional(),
  }).strict(),
  // Running totals from a long-lived producer (LiveKit agent job): server stores only the increase.
  z.object({
    kind: z.literal("snapshot"),
    source: z.enum(USAGE_SOURCES),
    sessionId: label,
    streamId: label,
    seq: z.number().int().nonnegative(),
    totals: z.array(item).min(1).max(50),
    meta: meta.optional(),
  }).strict(),
]);

export type UsageInput = z.infer<typeof usageInputSchema>;
export type UsageItem = z.infer<typeof item>;
export type UsageSource = (typeof USAGE_SOURCES)[number];
/** Who an in-process LLM call is billed to. sessionId wins; otherwise orgId (+ userId). */
export type UsageMeter = { source: UsageSource; sessionId?: string; orgId?: string; userId?: string };
export type UsageResult = { inserted: number } | { error: "unknown_session" | "missing_identity" };

type Identity = { orgId: string; userId: string | null; sessionId: string | null };

// Session-bound usage is attributed from the DB, never from producer-supplied ids.
async function resolveIdentity(input: UsageInput): Promise<Identity | "unknown_session" | "missing_identity"> {
  if (input.sessionId) {
    const session = await db.interviewSession.findUnique({
      where: { id: input.sessionId },
      select: { id: true, orgId: true, userId: true },
    });
    if (!session) return "unknown_session";
    return { orgId: session.orgId, userId: session.userId, sessionId: session.id };
  }
  if (input.kind === "delta" && input.orgId) {
    return { orgId: input.orgId, userId: input.userId ?? null, sessionId: null };
  }
  return "missing_identity";
}

// ---- in-process producers (web routes/jobs) ----

/** Provider label for an OpenAI-compatible base URL (AI Gateway or OpenRouter). */
export function gatewayProvider(baseUrl: string): string {
  const host = baseUrl.replace(/^https?:\/\//, "").split("/")[0];
  if (host.includes("vercel")) return "vercel";
  if (host.includes("openrouter")) return "openrouter";
  return host;
}

const positive = (provider: string, model: string, metric: UsageItem["metric"], value: unknown): UsageItem[] =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? [{ provider, model, metric, value }] : [];

/** OpenAI-compatible `usage` (AI Gateway / OpenRouter). completion_tokens already includes reasoning. */
export function chatCompletionItems(provider: string, model: string, usage: unknown): UsageItem[] {
  const u = (usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cache_creation_input_tokens?: number;
  };
  return [
    ...positive(provider, model, "input_tokens", u.prompt_tokens),
    ...positive(provider, model, "output_tokens", u.completion_tokens),
    ...positive(provider, model, "cache_read_tokens", u.prompt_tokens_details?.cached_tokens),
    ...positive(provider, model, "cache_write_tokens", u.cache_creation_input_tokens),
    ...positive(provider, model, "reasoning_tokens", u.completion_tokens_details?.reasoning_tokens), // subset of output
    ...positive(provider, model, "cost_usd", u.cost),
  ];
}

/** Gemini generateContent `usageMetadata`. Thinking tokens are billed as output but reported separately. */
export function geminiItems(model: string, usageMetadata: unknown): UsageItem[] {
  const u = (usageMetadata ?? {}) as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  const thoughts = u.thoughtsTokenCount ?? 0;
  return [
    ...positive("google", model, "input_tokens", u.promptTokenCount),
    ...positive("google", model, "output_tokens", (u.candidatesTokenCount ?? 0) + thoughts),
    ...positive("google", model, "cache_read_tokens", u.cachedContentTokenCount),
    ...positive("google", model, "reasoning_tokens", thoughts),
  ];
}

/** AI SDK LanguageModelUsage (use result.totalUsage for multi-step calls). */
export function aiSdkItems(provider: string, model: string, usage: unknown): UsageItem[] {
  const u = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  return [
    ...positive(provider, model, "input_tokens", u.inputTokens),
    ...positive(provider, model, "output_tokens", u.outputTokens),
    ...positive(provider, model, "cache_read_tokens", u.inputTokenDetails?.cacheReadTokens),
    ...positive(provider, model, "cache_write_tokens", u.inputTokenDetails?.cacheWriteTokens),
    ...positive(provider, model, "reasoning_tokens", u.outputTokenDetails?.reasoningTokens),
  ];
}

/** Records one call's usage. Never throws: metering must not break the feature it measures. */
export async function meterUsage(
  meter: UsageMeter | undefined,
  idempotencyKey: string | undefined,
  items: UsageItem[],
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!meter || items.length === 0) return;
  try {
    const result = await recordUsage({
      kind: "delta",
      source: meter.source,
      idempotencyKey: idempotencyKey || `${meter.source}:${randomUUID()}`,
      ...(meter.sessionId ? { sessionId: meter.sessionId } : {}),
      ...(meter.orgId ? { orgId: meter.orgId } : {}),
      ...(meter.userId ? { userId: meter.userId } : {}),
      items: items.slice(0, 50),
      ...(meta ? { meta } : {}),
    });
    if ("error" in result) console.warn(`[usage] ${meter.source} not recorded: ${result.error}`);
  } catch (error) {
    console.warn(`[usage] ${meter.source} record failed`, error);
  }
}

/** meterUsage after the response is sent; runs inline when outside a request scope (jobs, tests). */
export function meterUsageLater(...args: Parameters<typeof meterUsage>): void {
  if (!args[0] || args[2].length === 0) return;
  try {
    after(() => meterUsage(...args));
  } catch {
    void meterUsage(...args);
  }
}

export async function recordUsage(input: UsageInput): Promise<UsageResult> {
  const who = await resolveIdentity(input);
  if (typeof who === "string") return { error: who };
  const meta = input.meta as Prisma.InputJsonValue | undefined;

  if (input.kind === "delta") {
    const result = await db.usageEvent.createMany({
      data: input.items
        .filter((i) => i.value > 0)
        .map((i) => ({
          ...who,
          source: input.source,
          provider: i.provider,
          model: i.model,
          metric: i.metric,
          quantity: i.value,
          idempotencyKey: `${input.idempotencyKey}:${i.provider}:${i.model}:${i.metric}`,
          meta,
        })),
      skipDuplicates: true, // retried call → same keys → no-op
    });
    return { inserted: result.count };
  }

  // shortcut: read-then-write per cursor row; correct while one producer posts per streamId
  // serially (the agent holds a lock). Use SELECT … FOR UPDATE if streams ever post concurrently.
  return db.$transaction(async (tx) => {
    let inserted = 0;
    // Cursor is scoped to the session too, so a reused/colliding producer id can't mix sessions.
    const streamId = `${who.sessionId}:${input.streamId}`;
    for (const t of input.totals) {
      const key = { streamId, provider: t.provider, model: t.model, metric: t.metric };
      const cursor = await tx.usageCursor.findUnique({ where: { streamId_provider_model_metric: key } });
      const delta = t.value - (cursor?.lastValue ?? 0);
      if (delta <= 0) continue; // stale or replayed snapshot
      await tx.usageCursor.upsert({
        where: { streamId_provider_model_metric: key },
        create: { ...key, lastValue: t.value },
        update: { lastValue: t.value },
      });
      await tx.usageEvent.create({
        data: {
          ...who,
          source: input.source,
          provider: t.provider,
          model: t.model,
          metric: t.metric,
          quantity: delta,
          idempotencyKey: `${streamId}:${t.provider}:${t.model}:${t.metric}:${input.seq}`,
          meta: { ...(input.meta ?? {}), streamId: input.streamId, seq: input.seq } as Prisma.InputJsonValue,
        },
      });
      inserted += 1;
    }
    return { inserted };
  });
}
