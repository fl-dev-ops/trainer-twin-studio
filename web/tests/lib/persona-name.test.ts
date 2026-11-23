import { expect, test } from "bun:test";
import { personaNameOf } from "@/lib/specs";

test("the call screen names who the learner talks to: the role play's client name, else the persona's name", () => {
  expect(personaNameOf({ scenario: { roleplay: { clientName: " Daniel Hart " } } }, "Rohan Mehta")).toBe("Daniel Hart");
  expect(personaNameOf({ scenario: { roleplay: { clientName: "" } } }, "Rohan Mehta")).toBe("Rohan Mehta");
  expect(personaNameOf(null, "Ravi Menon")).toBe("Ravi Menon");
});
