import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const events = new Map<string, Row>();
const cursors = new Map<string, Row>();
// Same learner (u1) practising in two different orgs.
const sessions: Record<string, Row> = {
  s1: { id: "s1", orgId: "org1", userId: "u1" },
  s2: { id: "s2", orgId: "org2", userId: "u1" },
};
const cursorKey = (k: Row) => `${k.streamId}|${k.provider}|${k.model}|${k.metric}`;

const fakeDb = {
  interviewSession: { findUnique: async ({ where }: { where: { id: string } }) => sessions[where.id] ?? null },
  usageEvent: {
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates: boolean }) => {
      let count = 0;
      for (const row of data) {
        const key = row.idempotencyKey as string;
        if (events.has(key)) { if (!skipDuplicates) throw new Error("unique"); continue; }
        events.set(key, row);
        count++;
      }
      return { count };
    },
    create: async ({ data }: { data: Row }) => {
      if (events.has(data.idempotencyKey as string)) throw new Error("unique");
      events.set(data.idempotencyKey as string, data);
      return data;
    },
  },
  usageCursor: {
    findUnique: async ({ where }: { where: { streamId_provider_model_metric: Row } }) =>
      cursors.get(cursorKey(where.streamId_provider_model_metric)) ?? null,
    upsert: async ({ create, update, where }: { create: Row; update: Row; where: { streamId_provider_model_metric: Row } }) => {
      const key = cursorKey(where.streamId_provider_model_metric);
      cursors.set(key, { ...(cursors.get(key) ?? create), ...update });
    },
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};
mock.module("@/lib/db", () => ({ db: fakeDb }));

const { aiSdkItems, chatCompletionItems, gatewayProvider, geminiItems, meterUsage, recordUsage, usageInputSchema } =
  await import("@/lib/usage");
const { POST } = await import("@/app/api/internal/usage/route");

const total = (metric: string) =>
  [...events.values()].filter((e) => e.metric === metric).reduce((sum, e) => sum + (e.quantity as number), 0);
const snapshot = (seq: number, stt: number, chars: number) => ({
  kind: "snapshot" as const, source: "voice_agent" as const, sessionId: "s1", streamId: "job1", seq,
  totals: [
    { provider: "Deepgram", model: "flux-general-en", metric: "stt_seconds" as const, value: stt },
    { provider: "Sarvam", model: "bulbul:v3", metric: "tts_characters" as const, value: chars },
  ],
});

beforeEach(() => { events.clear(); cursors.clear(); process.env.COPILOT_SERVICE_SECRET = "secret"; });

test("snapshots store only increases; lost, replayed and stale posts never change totals", async () => {
  await recordUsage(snapshot(1, 6, 100));
  // seq 2 lost in transit; seq 3 carries the cumulative total
  await recordUsage(snapshot(3, 20, 350));
  await recordUsage(snapshot(3, 20, 350)); // retry
  await recordUsage(snapshot(2, 12, 200)); // late, stale delivery
  expect(total("stt_seconds")).toBe(20);
  expect(total("tts_characters")).toBe(350);
  const row = [...events.values()][0];
  expect(row).toMatchObject({ orgId: "org1", userId: "u1", sessionId: "s1", source: "voice_agent" });
});

test("a new agent job (stream) starts its own cursor", async () => {
  await recordUsage(snapshot(1, 30, 0));
  await recordUsage({ ...snapshot(1, 5, 0), streamId: "job2" }); // agent restarted mid-session
  expect(total("stt_seconds")).toBe(35);
});

test("same user in two orgs: each session bills its own org, cursors never mix", async () => {
  await recordUsage(snapshot(1, 30, 0));
  await recordUsage({ ...snapshot(1, 12, 0), sessionId: "s2" }); // same streamId, other org's session
  const byOrg = (org: string) => [...events.values()]
    .filter((e) => e.orgId === org && e.metric === "stt_seconds")
    .reduce((sum, e) => sum + (e.quantity as number), 0);
  expect(byOrg("org1")).toBe(30);
  expect(byOrg("org2")).toBe(12);
  expect([...events.values()].every((e) => e.userId === "u1")).toBe(true);
});

test("deltas are idempotent per key and skip zero quantities", async () => {
  const delta = {
    kind: "delta" as const, source: "chat" as const, sessionId: "s1", idempotencyKey: "eve:call-1",
    items: [
      { provider: "vercel", model: "google/gemini-3.5-flash-lite", metric: "input_tokens" as const, value: 3120 },
      { provider: "vercel", model: "google/gemini-3.5-flash-lite", metric: "output_tokens" as const, value: 214 },
      { provider: "vercel", model: "google/gemini-3.5-flash-lite", metric: "cache_read_tokens" as const, value: 0 },
    ],
  };
  expect(await recordUsage(delta)).toEqual({ inserted: 2 });
  expect(await recordUsage(delta)).toEqual({ inserted: 0 });
  expect(total("input_tokens")).toBe(3120);
});

test("session identity comes from the DB, not the producer", async () => {
  await recordUsage({
    kind: "delta", source: "chat", sessionId: "s1", orgId: "attacker-org", userId: "attacker", idempotencyKey: "k",
    items: [{ provider: "vercel", model: "m", metric: "input_tokens", value: 1 }],
  });
  expect([...events.values()][0]).toMatchObject({ orgId: "org1", userId: "u1" });
  expect(await recordUsage({ ...snapshot(1, 1, 1), sessionId: "missing" })).toEqual({ error: "unknown_session" });
  expect(await recordUsage({
    kind: "delta", source: "report", idempotencyKey: "k2",
    items: [{ provider: "vercel", model: "m", metric: "input_tokens", value: 1 }],
  })).toEqual({ error: "missing_identity" });
});

test("provider usage shapes map to ledger metrics without double counting", () => {
  const pick = (items: { metric: string; value: number }[]) => Object.fromEntries(items.map((i) => [i.metric, i.value]));
  // Live AI Gateway shape (verified): completion_tokens already includes reasoning_tokens.
  expect(pick(chatCompletionItems("vercel", "google/gemini-3.8-flash", {
    prompt_tokens: 2, completion_tokens: 16, total_tokens: 18, cost: 0.0000615,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 16 },
  }))).toEqual({ input_tokens: 2, output_tokens: 16, reasoning_tokens: 16, cost_usd: 0.0000615 });
  // Gemini reports thinking separately from candidates; both are billed as output.
  expect(pick(geminiItems("gemini-2.5-flash", {
    promptTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 40, cachedContentTokenCount: 300,
  }))).toEqual({ input_tokens: 900, output_tokens: 140, cache_read_tokens: 300, reasoning_tokens: 40 });
  expect(pick(aiSdkItems("openrouter", "openai/gpt-4o", {
    inputTokens: 1200, outputTokens: 80, inputTokenDetails: { cacheReadTokens: 0 }, outputTokenDetails: {},
  }))).toEqual({ input_tokens: 1200, output_tokens: 80 });
  expect(chatCompletionItems("vercel", "m", undefined)).toEqual([]);
  expect(gatewayProvider("https://ai-gateway.vercel.sh/v1")).toBe("vercel");
  expect(gatewayProvider("https://openrouter.ai/api/v1")).toBe("openrouter");
});

test("meterUsage never throws and skips unattributed calls", async () => {
  await meterUsage(undefined, "k", [{ provider: "p", model: "m", metric: "input_tokens", value: 1 }]);
  await meterUsage({ source: "report", sessionId: "missing" }, "k", [{ provider: "p", model: "m", metric: "input_tokens", value: 1 }]);
  expect(events.size).toBe(0);
  await meterUsage({ source: "report", sessionId: "s1" }, "gen:1", [{ provider: "p", model: "m", metric: "input_tokens", value: 7 }]);
  expect(total("input_tokens")).toBe(7);
});

test("schema rejects unknown metrics and negative values", () => {
  const bad = { ...snapshot(1, 1, 1), totals: [{ provider: "p", model: "m", metric: "dollars", value: 1 }] };
  expect(usageInputSchema.safeParse(bad).success).toBe(false);
  expect(usageInputSchema.safeParse(snapshot(1, -1, 1)).success).toBe(false);
});

test("route requires the service secret and validates input", async () => {
  const req = (body: unknown, auth?: string) => new Request("http://x/api/internal/usage", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  expect((await POST(req(snapshot(1, 1, 1)))).status).toBe(401);
  expect((await POST(req(snapshot(1, 1, 1), "wrong"))).status).toBe(401);
  expect((await POST(req({ kind: "nope" }, "secret"))).status).toBe(400);
  expect((await POST(req({ ...snapshot(1, 1, 1), sessionId: "missing" }, "secret"))).status).toBe(404);
  const ok = await POST(req(snapshot(1, 4, 40), "secret"));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, inserted: 2 });
});
