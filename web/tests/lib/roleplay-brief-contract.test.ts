import { expect, test } from "bun:test";
import { roleplayBriefSchema } from "@/lib/roleplay/brief";
import { roleplayBrief as copilotBrief } from "../../../copilot/agent/lib/roleplay-brief";
import { briefFixtures } from "../fixtures/roleplay-briefs";

// The copilot writes briefs with its own copy of the schema (it is deployed on its own); the studio checks them with
// this one. They must accept exactly the same shape.

type Def = { type?: string; shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; entries?: Record<string, string> };
const defOf = (schema: unknown) => (schema as { _zod: { def: Def } })._zod.def;
function shape(schema: unknown): unknown {
  const def = defOf(schema);
  if (def.type === "optional" || def.type === "default") return { [def.type]: shape(def.innerType) };
  if (def.type === "object") return Object.fromEntries(Object.entries(def.shape!).map(([key, value]) => [key, shape(value)]));
  if (def.type === "array") return [shape(def.element)];
  if (def.type === "enum") return Object.values(def.entries!).sort();
  return def.type;
}

test("the copilot's brief schema has exactly the studio's shape", () => {
  expect(shape(copilotBrief)).toEqual(shape(roleplayBriefSchema));
});

test("shared lines stay on the stage; a line only some personas may say does not", () => {
  expect(copilotBrief.shape.items.description).toContain("every persona on this stage");
  expect(copilotBrief.shape.items.description).toContain("only some personas");
  expect(copilotBrief.shape.items._zod.def.innerType._zod.def.element._zod.def.shape.tags.description).not.toMatch(/investor|end-user/);
  expect(copilotBrief.shape.ending._zod.def.shape.exitLine.description).toContain("every persona");
});

test.each(Object.keys(briefFixtures))("%s: what the copilot accepts, the studio accepts identically", (name) => {
  const copilot = copilotBrief.parse(briefFixtures[name].brief);
  expect(roleplayBriefSchema.parse(copilot)).toEqual(roleplayBriefSchema.parse(briefFixtures[name].brief));
});
