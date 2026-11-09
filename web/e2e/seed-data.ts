import { readFileSync } from "node:fs";

type Person = { id: string; name: string; email: string };
/** What e2e/seed.ts made this run (written before the specs start). */
export function seed(): { org: { slug: string; name: string }; admin: Person; learner: Person; broke: Person; more: Person[]; codes: { learner: string; broke: string } } {
  return JSON.parse(readFileSync("e2e/.state/seed.json", "utf8"));
}
export const as = (who: "admin" | "learner" | "broke") => ({ storageState: `e2e/.auth/${who}.json` });
