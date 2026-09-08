export type OpenRouterClient = {
  apiKey: string;
  baseUrl: string;
  rerank: {
    rerank(
      params: { requestBody: { model: string; query: string; documents: string[]; topN?: number } },
      opts?: { timeoutMs?: number },
    ): Promise<{ results: { index: number; relevanceScore: number }[] }>;
  };
};

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Initializes OpenRouter credentials using standard fetch. Zero external dependencies. */
export function createOpenRouter(apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY): OpenRouterClient {
  if (!apiKey?.trim()) throw new Error("OPENROUTER_API_KEY is not set");
  const key = apiKey.trim();
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

  return {
    apiKey: key,
    baseUrl,
    rerank: {
      async rerank(params, opts) {
        const timeoutMs = opts?.timeoutMs ?? 30_000;
        const response = await fetch(`${baseUrl}/rerank`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: params.requestBody.model,
            query: params.requestBody.query,
            documents: params.requestBody.documents,
            top_n: params.requestBody.topN ?? params.requestBody.documents.length,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`OpenRouter rerank returned ${response.status}: ${await response.text()}`);
        }

        const body = (await response.json()) as {
          results?: { index: number; relevance_score?: number; relevanceScore?: number }[];
        };
        if (!Array.isArray(body.results)) throw new Error("Expected structured rerank results");

        return {
          results: body.results.map((r) => ({
            index: r.index,
            relevanceScore: r.relevanceScore ?? r.relevance_score ?? 0,
          })),
        };
      },
    },
  };
}

/** Preserve three attempts, including malformed JSON, without stacking SDK retries. */
export async function generateTopicJson(
  client: OpenRouterClient,
  model: string,
  system: string,
  user: string,
  operation = "topic-classification",
): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const startedAt = Date.now();
    console.info(`[LLM:${operation}] start model=${model} attempt=${attempt}`);
    try {
      const response = await fetch(`${client.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${client.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter returned ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("Expected structured JSON text");
      const result: unknown = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
      console.info(`[LLM:${operation}] complete model=${model} elapsedMs=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      console.error(`[LLM:${operation}] failed model=${model} attempt=${attempt} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
      if (attempt < 3) await delay(500 * attempt * attempt);
    }
  }
  // SDK and JSON parsing errors can contain source text; do not propagate those to job logs.
  throw new Error(`${operation} model call failed`);
}

/** Batch embeddings once for both web and Lambda, preserving input/vector alignment. */
export async function generateEmbeddings(client: OpenRouterClient, model: string, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += 100) {
    const batch = texts.slice(start, start + 100);
    const startedAt = Date.now();
    console.info(`[LLM:embeddings] start model=${model} count=${batch.length}`);
    try {
      const response = await fetch(`${client.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${client.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: batch,
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter embeddings returned ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
      if (!Array.isArray(body.data) || body.data.length !== batch.length) {
        throw new Error("Incomplete embeddings");
      }

      const ordered = [...body.data].sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
      for (const [index, item] of ordered.entries()) {
        if (item.index !== index || !Array.isArray(item.embedding) || !item.embedding.length) {
          throw new Error("Invalid embedding alignment");
        }
        vectors.push(item.embedding);
      }
      console.info(`[LLM:embeddings] complete model=${model} count=${batch.length} elapsedMs=${Date.now() - startedAt}`);
    } catch (error) {
      console.error(`[LLM:embeddings] failed model=${model} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
      throw new Error("Embedding request failed");
    }
  }
  return vectors;
}
