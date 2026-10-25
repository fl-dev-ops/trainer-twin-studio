import { expect, test } from "bun:test";
import { personaQuote } from "@/lib/specs";

const persona = {
  examples: {
    narrow_hint: [
      "Got it. So what about the first approach, the brute force one — you'll be able to write that?",
      "Okay.",
      "x".repeat(200),
    ],
    praise: ["Nice, that is   exactly the trade-off I wanted."],
    notes: "not a list",
  },
};

test("picks a short real trainer line, whitespace-normalized", () => {
  const quote = personaQuote(persona, "scenario-a");
  expect([
    "Got it. So what about the first approach, the brute force one — you'll be able to write that?",
    "Nice, that is exactly the trade-off I wanted.",
  ]).toContain(quote!);
  expect(personaQuote(persona, "scenario-a")).toBe(quote); // stable per scenario
});

test("no usable lines → no quote", () => {
  expect(personaQuote({ examples: { a: ["Okay.", "x".repeat(200)] } }, "s")).toBeUndefined();
  expect(personaQuote(null, "s")).toBeUndefined();
  expect(personaQuote({ examples: "nope" }, "s")).toBeUndefined();
});
