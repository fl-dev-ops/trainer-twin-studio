import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Middleware, LanguageModelV4StreamPart } from "@ai-sdk/provider";

/**
 * Cross-route hedged model calls. On Vertex, some Gemini calls stall 16–22 s before any output
 * while producing a normal-sized answer (no extra thinking) — waiting at the backend, not working.
 * If the primary attempt has produced no output after `afterMs`, a duplicate goes to the backup
 * route (a different Google backend, e.g. AI Studio); whichever produces output first wins and the
 * other is aborted. LLM calls have no side effects (tools run from the winner's output only).
 *
 * An earlier same-route hedge never won: those slow calls were heavy thinking, which an identical
 * copy repeats. Stalls are per request, so a copy on another backend should usually answer in ~2–3 s.
 */

/** Parts that arrive before real output; they don't decide the race. */
const PRELUDE_PARTS = new Set(["stream-start", "response-metadata", "reasoning-start", "reasoning-delta", "reasoning-end", "raw"]);

export type HedgeEvent = { hedged: boolean; winner: "primary" | "backup"; firstOutputMs: number };

type Attempt = {
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<LanguageModelV4StreamPart>;
  buffer: LanguageModelV4StreamPart[];
  failed: boolean;
};

export type HedgeOptions = {
  afterMs: number;
  /** Turns the primary call's options into the backup call's (e.g. a different gateway route). */
  backupParams?: (params: LanguageModelV4CallOptions) => LanguageModelV4CallOptions;
  onSettled?: (event: HedgeEvent) => void;
};

export function hedgedStreamMiddleware(options: HedgeOptions): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapStream: async ({ params, model }) => ({ stream: hedgedStream(model, params, options) }),
  };
}

/** Swap the AI Gateway provider restriction, keeping every other provider option. */
export function routeTo(provider: string) {
  return (params: LanguageModelV4CallOptions): LanguageModelV4CallOptions => {
    const providerOptions = (params.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
    return { ...params, providerOptions: { ...providerOptions, gateway: { ...(providerOptions.gateway ?? {}), only: [provider] } } } as LanguageModelV4CallOptions;
  };
}

function hedgedStream(model: LanguageModelV4, params: LanguageModelV4CallOptions, { afterMs, backupParams, onSettled }: HedgeOptions): ReadableStream<LanguageModelV4StreamPart> {
  const startedAt = Date.now();
  const attempts: Attempt[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<LanguageModelV4StreamPart>({
    start(output) {
      return new Promise<void>((settle) => {
        let winner: Attempt | null = null;

        const finishWith = (attempt: Attempt) => {
          winner = attempt;
          clearTimeout(timer);
          for (const other of attempts) {
            if (other !== attempt) {
              other.controller.abort();
              void other.reader?.cancel().catch(() => {});
            }
          }
          onSettled?.({ hedged: attempts.length > 1, winner: attempts.indexOf(attempt) === 0 ? "primary" : "backup", firstOutputMs: Date.now() - startedAt });
          for (const part of attempt.buffer) output.enqueue(part);
          attempt.buffer = [];
          settle();
        };

        const launch = (callParams: LanguageModelV4CallOptions) => {
          const attempt: Attempt = { controller: new AbortController(), buffer: [], failed: false };
          params.abortSignal?.addEventListener("abort", () => attempt.controller.abort(), { once: true });
          attempts.push(attempt);
          void (async () => {
            try {
              const result = await model.doStream({ ...callParams, abortSignal: attempt.controller.signal });
              attempt.reader = result.stream.getReader();
              while (true) {
                const { done, value } = await attempt.reader.read();
                if (winner && winner !== attempt) return;
                if (done) {
                  if (!winner) finishWith(attempt);
                  output.close();
                  return;
                }
                if (winner === attempt) {
                  output.enqueue(value);
                  continue;
                }
                attempt.buffer.push(value);
                if (!PRELUDE_PARTS.has(value.type)) finishWith(attempt);
              }
            } catch (error) {
              if (winner === attempt) {
                output.error(error);
                return;
              }
              if (winner) return;
              attempt.failed = true;
              // Surface the error only once no other attempt can still win.
              if (!attempts.some((other) => !other.failed)) {
                clearTimeout(timer);
                output.error(error);
                settle();
              }
            }
          })();
        };

        launch(params);
        timer = setTimeout(() => {
          if (!winner && !params.abortSignal?.aborted) launch(backupParams ? backupParams(params) : params);
        }, afterMs);
      });
    },
    cancel() {
      clearTimeout(timer);
      for (const attempt of attempts) {
        attempt.controller.abort();
        void attempt.reader?.cancel().catch(() => {});
      }
    },
  });
}
