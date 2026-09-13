const names = [
  "gpt-4.1-mini",
  "gpt-4.1-nano-nitro",
  "gemini-2.5-flash-lite-nitro",
  "gpt-4.1-mini-rerank",
];
const learner = {
  "ownership-answer": "I personally designed and led the migration of our order-processing monolith into event-driven services. I owned the architecture, broke the work into milestones, and reviewed the implementation from five engineers.",
  "mechanism-answer": "We used Kafka with an outbox pattern so database writes and emitted events stayed consistent. Consumers were idempotent using the order ID, and we used dead-letter queues with replay tooling for failures.",
  "impact-answer": "After rollout, deployment time fell from 40 minutes to 8 minutes, order-processing failures dropped by 35 percent, and the team moved from weekly releases to daily releases.",
};

const runs = Object.fromEntries(await Promise.all(names.map(async (name) => {
  const data = await Bun.file(new URL(`./bench-results-${name}.json`, import.meta.url)).json();
  return [name, Object.fromEntries(data.turns
    .filter((turn: any) => learner[turn.label as keyof typeof learner])
    .map((turn: any) => [turn.label, turn.response]))];
})));

function retrieved(name: "gpt-4.1-mini" | "gpt-4.1-mini-rerank") {
  return Bun.file(new URL(`./bench-results-${name}.json`, import.meta.url)).json().then((data: any) =>
    Object.fromEntries(data.turns
      .filter((turn: any) => learner[turn.label as keyof typeof learner])
      .map((turn: any) => {
        const knowledge = turn.events.find((event: any) => event.stage === "knowledge.search");
        const records = knowledge?.meta?.records ?? [];
        const reranker = turn.events.find((event: any) => event.stage === "reranker");
        const selected = reranker
          ? (reranker.meta?.ranking ?? []).slice(0, 3).map((rank: any) => ({ ...records[rank.index], rerankScore: rank.relevance_score }))
          : records.slice(0, 3);
        return [turn.label, selected.map((record: any) => ({ source: record.source, score: record.rerankScore ?? record.score, text: record.text }))];
      })),
  );
}

const retrieval = {
  "without-reranker": await retrieved("gpt-4.1-mini"),
  "with-reranker": await retrieved("gpt-4.1-mini-rerank"),
};

const prompt = `Evaluate a voice interview runtime using only the data below.

For each response variant and each turn, score 1-5 for:
- relevance: responds to the latest learner answer and progresses the interview
- grounding: uses only learner-provided facts and does not invent details
- interview_quality: asks a useful, focused next question without needlessly repeating an already answered point
- naturalness: concise, understandable spoken language

Also score each retrieval set 1-5 for relevance to the latest learner answer and the objective: establish the project problem, personal ownership, concrete contribution, technical mechanism, decision reasoning, challenges, alternatives, individual-vs-team contribution, and outcome.

Be strict. Explain concrete differences in one short sentence per variant. Return JSON only with keys response_scores, response_summary, retrieval_scores, retrieval_summary, recommended_variant, confidence, limitations.

Latest learner answers:
${JSON.stringify(learner)}

Responses:
${JSON.stringify(runs)}

Retrieved knowledge:
${JSON.stringify(retrieval)}`;

const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "openai/gpt-4.1",
    temperature: 0,
    max_tokens: 2500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a strict evaluator of technical interview conversations and RAG relevance. Output valid JSON only." },
      { role: "user", content: prompt },
    ],
  }),
});
if (!response.ok) throw new Error(`Judge failed: ${response.status} ${await response.text()}`);
const payload = await response.json() as any;
const result = JSON.parse(payload.choices[0].message.content);
await Bun.write(new URL("./bench-quality-judge.json", import.meta.url), JSON.stringify({ judge: "openai/gpt-4.1", result, usage: payload.usage }, null, 2));
console.log(JSON.stringify(result, null, 2));
