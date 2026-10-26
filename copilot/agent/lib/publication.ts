import { check, checkScout, knownNames, leaks, planInput } from "./ingest";
import { type Io, outPath, readJson } from "./paths";

/** Validate a snapshot before publishing any bytes. Failed scenarios stay out of the published plan. */
export async function preparePublication(io: Io, user: string) {
  const root = outPath(user, ".").replace(/\/\.$/, "") + "/";
  const snapshot = new Map(await Promise.all((await io.list(root.slice(0, -1))).map(async (p) => [p, await io.read(p)] as const)));
  const frozen: Io = { ...io, read: async (p) => p.startsWith(root) ? snapshot.get(p) ?? null : io.read(p) };
  const planned = await checkScout(frozen, user);
  if (!planned.pass) return { files: [], rejected: planned.reasons };
  const plan = planInput.parse(await readJson(frozen, user, "plan.json", null));
  const names = await knownNames(frozen, user);
  const common = ["report.md", ...[...snapshot.keys()].map((p) => p.slice(root.length)).filter((p) => /^specs\/[^/]+\.md$/.test(p))];
  const rejected: string[] = [];
  const files: { path: string; text: string }[] = [];
  for (const path of common) {
    const text = await frozen.read(outPath(user, path));
    if (text == null) rejected.push(`${path} is missing`);
    else if (leaks(text, names).length) rejected.push(`${path} contains personal details; redact it before publishing`);
    else files.push({ path, text });
  }
  if (rejected.length) return { files: [], rejected };
  const approved = [];
  for (const scenario of plan.scenarios) {
    try {
      const result = await check(frozen, user, scenario.id, "all");
      if (!result.pass) { rejected.push(`${scenario.id}: ${result.reasons.join("; ")}`); continue; }
      approved.push(scenario);
      for (const name of ["SKILL.md", "scenario.json", "items.json", "patterns.md"]) {
        const path = `${scenario.id}/${name}`;
        const text = await frozen.read(outPath(user, path));
        if (text == null) throw new Error(`${path} disappeared from the publication snapshot`);
        files.push({ path, text });
      }
    } catch (e) { rejected.push(`${scenario.id}: ${(e as Error).message}`); }
  }
  files.push({ path: "plan.json", text: JSON.stringify({ scenarios: approved }, null, 1) + "\n" });
  return { files, rejected };
}
