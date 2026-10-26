import { setTimeout as sleep } from "node:timers/promises";
import { createCerebras } from "@ai-sdk/cerebras";
import { wrapLanguageModel } from "ai";

const cerebras = createCerebras({ apiKey: process.env.CEREBRAS_API_KEY });

export function isRateLimit(e: unknown) {
  const err = e as { statusCode?: number; message?: string } | undefined;
  return err?.statusCode === 429 && !/quota|billing|credit|per day/i.test(err.message ?? "");
}

/** One bounded, abortable wait for HTTP rate limits. Eve owns retries of errors emitted inside an open stream. */
export async function waitOnRateLimit<T>(call: () => PromiseLike<T>, signal?: AbortSignal,
  wait = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal })) : Promise<T> {
  signal?.throwIfAborted();
  try { return await call(); }
  catch (e) {
    signal?.throwIfAborted();
    if (!isRateLimit(e)) throw e;
    const header = (e as { responseHeaders?: Record<string, string> }).responseHeaders?.["retry-after"];
    const seconds = header ? Number(header) : NaN;
    const delay = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : 60_000;
    const delayMs = Number.isFinite(delay) ? Math.max(0, delay) : 60_000;
    // A longer provider window must fail visibly rather than occupy an unbounded model step.
    if (delayMs > 60_000) { console.warn("[cerebras.retry] provider wait exceeds 60s; returning failure"); throw e; }
    console.warn("[cerebras.retry] waiting", { delayMs });
    await wait(delayMs, signal);
    signal?.throwIfAborted();
    console.warn("[cerebras.retry] retrying");
    return await call();
  }
}

const qwen = {
  model: wrapLanguageModel({
    model: cerebras("qwen-3.8-27b"),
    middleware: {
      wrapGenerate: ({ doGenerate, params }) => waitOnRateLimit(doGenerate, params.abortSignal),
      wrapStream: ({ doStream, params }) => waitOnRateLimit(doStream, params.abortSignal),
    },
  }),
  context: 65_536,
};

export const MODELS = { main: qwen, scout: qwen, pattern: qwen, skill: qwen, items: qwen };
export const LIMITS = { sessionUsage: () => false, sessionTimeoutMs: false as const };
