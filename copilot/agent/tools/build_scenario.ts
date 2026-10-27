import { defineTool } from "eve/tools";
import { z } from "zod";
import { check, type Item, itemInput, saveItems, savePlan, saveSkill, skillHead } from "../lib/ingest";
import { outPath, readJson } from "../lib/paths";
import { sessionIo } from "../lib/session-io";
const plan = z.object({ id: z.string(), name: z.string(), goal: z.string(), spec: z.string().optional(), method: z.array(z.string()).default([]), sessions: z.array(z.object({ id: z.string(), trainer: z.array(z.string()).min(1), learner: z.array(z.string()).min(1), plays: z.record(z.string(), z.string()), spans: z.array(z.tuple([z.number().int(), z.number().int()])).min(1) })) });
export default defineTool({
  description: "Role play only (roleplay-creator), never a twin skill. Save one scenario's plan, patterns, classified evidence and playbook in one call, then run the full check. Returns the first rejection, or the saved result with every check reason, so fix all reasons in the next call.",
  inputSchema: z.object({ user: z.string(), plan, names: z.array(z.string()).default([]), patterns: z.string().min(1), items: z.array(itemInput).min(1), skill: skillHead, body: z.string().min(1) }),
  async execute({ user, plan, names, patterns, items, skill, body }, ctx) {
    try {
      const io = await sessionIo(ctx);
      const savedPlan = await savePlan(io, user, { scenarios: [plan] }, names);
      if (!savedPlan.saved) return savedPlan;
      await io.write(outPath(user, `${plan.id}/patterns.md`), patterns.trim() + "\n");
      // A rebuild replaces earlier attempts' items; saveItems writes nothing if any new item is rejected.
      const old = (await readJson<Item[]>(io, user, `${plan.id}/items.json`, [])).map((x) => x.id);
      const savedItems = await saveItems(io, user, plan.id, items, names, old);
      if (savedItems.rejected.length) return savedItems;
      const savedSkill = await saveSkill(io, user, skill, body);
      if (!savedSkill.saved) return savedSkill;
      return { saved: true, check: await check(io, user, plan.id, "all") };
    } catch (e) { return { error: (e as Error).message }; }
  },
});
