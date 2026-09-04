import { OpenRouter } from "@openrouter/sdk";

/** Use the SDK's endpoint; imports stay safe without credentials until a call is made. */
export function createOpenRouter(apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY): OpenRouter {
  if (!apiKey?.trim()) throw new Error("OPENROUTER_API_KEY is not set");
  return new OpenRouter({ apiKey, timeoutMs: 120_000, retryConfig: { strategy: "none" } });
}

/** Preserve three attempts, including malformed JSON, without stacking SDK retries. */
export async function generateTopicJson(
  client: OpenRouter,
  model: string,
  system: string,
  user: string,
  operation = "topic-classification",
): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const startedAt = Date.now();
    console.info(`[LLM:${operation}] start model=${model} attempt=${attempt}`);
    try {
      const response = await client.chat.send({ chatRequest: {
        model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
        responseFormat: { type: "json_object" }, temperature: 0, stream: false,
      } });
      if (!("choices" in response)) throw new Error("Expected a non-streaming structured response");
      const content = response.choices[0]?.message.content;
      if (typeof content !== "string") throw new Error("Expected structured JSON text");
      const result: unknown = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
      console.info(`[LLM:${operation}] complete model=${model} elapsedMs=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      console.error(`[LLM:${operation}] failed model=${model} attempt=${attempt} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt * attempt));
    }
  }
  // SDK and JSON parsing errors can contain source text; do not propagate those to job logs.
  throw new Error(`${operation} model call failed`);
}

/** Batch embeddings once for both web and Lambda, preserving input/vector alignment. */
export async function generateEmbeddings(client: OpenRouter, model: string, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += 100) {
    const batch = texts.slice(start, start + 100);
    const startedAt = Date.now();
    console.info(`[LLM:embeddings] start model=${model} count=${batch.length}`);
    try {
      const response = await client.embeddings.generate({ requestBody: { model, input: batch, encodingFormat: "float" } });
      if (typeof response === "string" || response.data.length !== batch.length) throw new Error("Incomplete embeddings");
      const ordered = [...response.data].sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
      for (const [index, item] of ordered.entries()) {
        if (item.index !== index || !Array.isArray(item.embedding) || !item.embedding.length) throw new Error("Invalid embedding alignment");
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
