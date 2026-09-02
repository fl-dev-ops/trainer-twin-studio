// Shared OpenRouter JSON-mode chat helper for the bench harness.
export async function llmJson(
  system: string,
  user: string,
  opts?: { model?: string; temperature?: number },
): Promise<unknown> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = opts?.model ?? process.env.JUDGE_MODEL ?? process.env.TOPIC_MODEL ?? "openai/gpt-4o-mini";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: opts?.temperature ?? 0,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`LLM returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content ?? "";
  return JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
}

/** Cross-encoder rerank through OpenRouter (same endpoint the studio uses). */
export async function rerank(query: string, documents: string[], topN: number): Promise<number[]> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.RERANK_MODEL ?? "cohere/rerank-v3.5";
  const res = await fetch(`${baseUrl}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, query, documents, top_n: topN }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`rerank returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { results: { index: number }[] };
  return body.results.map((r) => r.index);
}
