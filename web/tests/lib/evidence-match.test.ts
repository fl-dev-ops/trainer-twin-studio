import { describe, expect, test } from "bun:test";
import { evidenceFor } from "@/lib/twin/evidence-match";

const turns = [
  { id: "a", reply: "Hi Olga. Tell me, what is going on with your client right now?" },
  { id: "b", reply: "Take a breath. You are in front of the client right now.\n\nTell me, what kind of property are you offering them?" },
  { id: "c", reply: "Do not argue with him. Ask what he is really afraid of." },
];

describe("evidenceFor", () => {
  test("a whole reply matches its turn", () => {
    expect(evidenceFor(turns, "Do not argue with him. Ask what he is really afraid of.")?.id).toBe("c");
  });
  test("a later paragraph of a reply (its own live bubble) matches the same turn", () => {
    expect(evidenceFor(turns, "Tell me, what kind of property are you offering them?")?.id).toBe("b");
  });
  test("punctuation and case don't matter", () => {
    expect(evidenceFor(turns, "take a breath - you are in front of the client right now")?.id).toBe("b");
  });
  test("a bubble from no recorded reply matches nothing", () => {
    expect(evidenceFor(turns, "What felt off about that reply?")).toBeNull();
    expect(evidenceFor(turns, "")).toBeNull();
  });
  test("a repeated reply resolves to the latest turn", () => {
    expect(evidenceFor([...turns, { id: "d", reply: turns[1].reply }], "Take a breath.")?.id).toBe("d");
  });
});
