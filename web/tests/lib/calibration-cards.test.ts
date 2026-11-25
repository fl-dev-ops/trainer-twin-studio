import { afterEach, expect, spyOn, test } from "bun:test";
import { askTwinOnCard, replyFromStream } from "@/lib/twin/calibration-cards";

const sse = (...parts: string[]) => [
  ...parts.map((content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}`),
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], brain_trace: {} })}`,
  "data: [DONE]",
  "",
].join("\n\n");

test("replyFromStream joins the content deltas and skips everything else", () => {
  expect(replyFromStream(sse("First ask: ", "compared to what?"))).toBe("First ask: compared to what?");
  expect(replyFromStream(": keep-alive\n\ndata: not json\n\n" + sse("ok"))).toBe("ok");
  expect(replyFromStream("data: [DONE]\n\n")).toBe("");
});

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("askTwinOnCard asks the card's own conversation in the calibration's session, in text", async () => {
  process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(sse("Ask what they're comparing it to.")));
  const reply = await askTwinOnCard({ orgId: "org1", sessionId: "s1", agentSlug: "olga-twin", cardId: "card1", text: "3% is too much?" });
  expect(reply).toBe("Ask what they're comparing it to.");
  const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
  expect(String(url)).toEndWith("/v1/chat/completions");
  expect(init.headers).toMatchObject({
    "x-trainertwin-session-id": "s1", "x-trainertwin-conversation-id": "card1", "x-trainertwin-agent-slug": "olga-twin", "x-trainertwin-mode": "chat",
  });
  expect(JSON.parse(String(init.body)).messages).toEqual([{ role: "user", content: "3% is too much?" }]);
});

test("askTwinOnCard throws on a failed or empty reply", async () => {
  process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 502 }));
  await expect(askTwinOnCard({ orgId: "o", sessionId: "s", agentSlug: "a", cardId: "c", text: "q" })).rejects.toThrow(/502/);
  fetchSpy.mockResolvedValue(new Response(sse()));
  await expect(askTwinOnCard({ orgId: "o", sessionId: "s", agentSlug: "a", cardId: "c", text: "q" })).rejects.toThrow(/empty/);
});
