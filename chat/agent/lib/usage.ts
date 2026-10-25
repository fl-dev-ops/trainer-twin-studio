/**
 * Posts LLM usage to the web ledger (POST /api/internal/usage). Fire-and-forget with one retry:
 * eve awaits instrumentation handlers before a step continues, so callers must never await the
 * network on the hot path — use trackUsage() and let flushUsage() drain pending posts.
 */
const studioUrl = process.env.STUDIO_URL ?? "http://localhost:3000";
const TIMEOUT_MS = 3_000;

export type UsageMetric = "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "embedding_tokens" | "cost_usd";
export type UsageItem = { provider: string; model: string; metric: UsageMetric; value: number };
export type UsageDelta = {
  kind: "delta";
  source: "chat" | "copilot";
  idempotencyKey: string;
  sessionId?: string;
  orgId?: string;
  userId?: string;
  items: UsageItem[];
  meta?: Record<string, unknown>;
};

/** Normalized eve/AI SDK token usage → ledger items (zeros dropped server-side). */
export function tokenItems(
  provider: string,
  model: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  },
): UsageItem[] {
  const item = (metric: UsageMetric, value: number | undefined): UsageItem[] =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? [{ provider, model, metric, value }] : [];
  return [
    ...item("input_tokens", usage.inputTokens),
    ...item("output_tokens", usage.outputTokens),
    ...item("cache_read_tokens", usage.inputTokenDetails?.cacheReadTokens),
    ...item("cache_write_tokens", usage.inputTokenDetails?.cacheWriteTokens),
    ...item("cost_usd", usage.costUsd),
  ];
}

export async function postUsage(payload: UsageDelta): Promise<void> {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret || payload.items.length === 0) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(new URL("/api/internal/usage", studioUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return;
      // 4xx (bad payload, unknown session) won't succeed on retry; 5xx/429 might.
      if (response.status < 500 && response.status !== 429) {
        console.warn("[usage] rejected " + JSON.stringify({ status: response.status, key: payload.idempotencyKey, body: (await response.text()).slice(0, 200) }));
        return;
      }
    } catch (error) {
      if (attempt === 1) console.warn("[usage] post failed " + JSON.stringify({ key: payload.idempotencyKey, error: String(error) }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const pending = new Set<Promise<void>>();

/** Start a post without blocking the caller; idempotency keys make retries safe. */
export function trackUsage(payload: UsageDelta): void {
  const task = postUsage(payload).catch(() => {}).finally(() => pending.delete(task));
  pending.add(task);
}

export async function flushUsage(): Promise<void> {
  await Promise.allSettled([...pending]);
}
