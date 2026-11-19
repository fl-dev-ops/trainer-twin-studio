import { afterEach, expect, spyOn, test } from "bun:test";
import { callOpenRouter, REASONING_TOKEN_ALLOWANCE } from "@/lib/runtime/openai";

// Reasoning models spend hidden tokens inside max_tokens; the runtime caps are the visible answer budget.
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function reply(finish: string, content = "Which part did you design?") {
  const bodies: Record<string, unknown>[] = [];
  spies.push(spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: finish, message: { content } }], usage: { completion_tokens_details: { reasoning_tokens: 700 } } });
  }));
  return bodies;
}

test("every runtime call adds the reasoning allowance on top of the caller's answer budget", async () => {
  const bodies = reply("stop");
  spies.push(spyOn(console, "info").mockImplementation(() => {}));
  await callOpenRouter("move", [{ role: "user", content: "x" }]);
  await callOpenRouter("direction", [{ role: "user", content: "x" }], true);
  await callOpenRouter("styled_generation", [{ role: "user", content: "x" }], false, undefined, 250);
  expect(bodies.map((body) => body.max_tokens)).toEqual([500, 1400, 250].map((n) => n + REASONING_TOKEN_ALLOWANCE));
  expect(REASONING_TOKEN_ALLOWANCE).toBeGreaterThanOrEqual(1024);
});

test("a reply that still hits the limit is reported, not silently used as complete", async () => {
  reply("length", "Which part did you");
  spies.push(spyOn(console, "info").mockImplementation(() => {}));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  spies.push(warn);
  expect(await callOpenRouter("move", [{ role: "user", content: "x" }])).toBe("Which part did you");
  expect(warn).toHaveBeenCalledWith("[interview-runtime] move reply hit the token limit", expect.anything());
});
