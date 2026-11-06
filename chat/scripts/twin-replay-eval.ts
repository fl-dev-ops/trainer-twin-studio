/**
 * Replays real twin conversations against two system prompts and measures the turn shape of each reply.
 * For every twin turn, the model gets the conversation up to that point (the real earlier replies) and writes its
 * own reply; a judge then labels it. No tools: the playbooks are inlined as already loaded, the same for both.
 *
 *   bun scripts/twin-replay-eval.ts <transcripts.json> <variantA.json> <variantB.json> [out.json]
 *
 * transcripts.json: [{ id, transcript: [{ role: "trainer" | "user", text }] }]  (a TwinCalibration export)
 * variant.json:     { system, feelsOff, playbooks: [{ id, skill }] }  (feelsOff: the turn text "Feels off" becomes)
 * Needs AI_GATEWAY_API_KEY. Model: CHAT_AGENT_MODEL or google/gemini-3.8-flash; judge: EVAL_JUDGE_MODEL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createGateway, generateText, type ModelMessage } from "ai";

type Turn = { role: string; text: string };
type Variant = { system: string; feelsOff: string; playbooks: { id: string; skill: string }[] };
type Label = { advises: boolean; interviews: boolean; flattery: boolean; redoes: boolean | null };

const [transcriptsPath, aPath, bPath, outPath = "/tmp/twin-replay-eval.json"] = process.argv.slice(2);
if (!transcriptsPath || !aPath || !bPath) throw new Error("usage: twin-replay-eval.ts <transcripts.json> <variantA.json> <variantB.json> [out.json]");

const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
const MODEL = process.env.CHAT_AGENT_MODEL || "google/gemini-3.8-flash";
const JUDGE = process.env.EVAL_JUDGE_MODEL || "openai/gpt-5-mini";
const OPENING = "[OPENING] Generate the session opening.";
const isFeelsOff = (text: string) => /^feels? off$/.test(text.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim());

const conversations = JSON.parse(readFileSync(transcriptsPath, "utf8")) as { id: string; transcript: Turn[] }[];
const variants = { A: JSON.parse(readFileSync(aPath, "utf8")) as Variant, B: JSON.parse(readFileSync(bPath, "utf8")) as Variant };

function system(variant: Variant) {
  const loaded = variant.playbooks.map((p) => `<playbook name="${p.id}">\n${p.skill}\n</playbook>`).join("\n");
  return `${variant.system}\n\nLOADED PLAYBOOKS (already loaded with eve__skill for this replay; tools are unavailable, answer directly)\n${loaded}`;
}

/** The conversation before twin turn `k`, as the model saw it (feedback presses as the variant's event text). */
function history(turns: Turn[], k: number, variant: Variant): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: OPENING }];
  for (const turn of turns.slice(0, k)) {
    if (turn.role === "trainer") messages.push({ role: "assistant", content: turn.text });
    else messages.push({ role: "user", content: isFeelsOff(turn.text) ? variant.feelsOff : turn.text });
  }
  return messages;
}

async function reply(variant: Variant, messages: ModelMessage[]) {
  const { text } = await generateText({
    model: gateway(MODEL),
    system: system(variant),
    messages,
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
  });
  return text.trim();
}

async function label(lastUser: string, afterExplanation: boolean, text: string): Promise<Label> {
  const { text: raw } = await generateText({
    model: gateway(JUDGE),
    prompt: `A sales trainer's AI twin advises a learner on real client situations. Label the twin's reply.
Learner's last message: """${lastUser}"""
Twin's reply: """${text}"""
${afterExplanation ? "Context: the learner's last message is the trainer explaining why the twin's previous reply felt off.\n" : ""}
Answer with JSON only: {"advises": bool, "interviews": bool, "flattery": bool, "redoes": bool|null}
- advises: gives a concrete next move or exact words to use with the client.
- interviews: asks the learner about their own methods, habits, results or feelings, asks them to elaborate on their approach, or quizzes them on what they would say or do next. Questions about the client's situation (what was said, who the client is, where the deal stands) do NOT count.
- flattery: praise or grading of the learner or their approach ("brilliant", "genius", "pure gold", "so sharp", "solid move").
- redoes: ${afterExplanation ? "true if the reply gives a corrected version of the advice the way the trainer explained" : "null"}.`,
  });
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Label;
}

/** Runs `fn` over `items`, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const cases = conversations.flatMap((c) => (c.transcript ?? []).flatMap((turn, k) => {
  const prev = c.transcript[k - 1];
  if (turn.role !== "trainer" || prev?.role !== "user") return [];
  return [{ id: c.id, k, lastUser: prev.text, afterExplanation: Boolean(c.transcript[k - 2] && isFeelsOff(c.transcript[k - 2].text) && !isFeelsOff(prev.text)), feelsOff: isFeelsOff(prev.text) }];
}));

const results = await pool(cases, 6, async (item) => {
  const turns = conversations.find((c) => c.id === item.id)!.transcript;
  const scored = async (text: string) => ({ text, endsWithQuestion: text.trimEnd().endsWith("?"), words: text.split(/\s+/).filter(Boolean).length, ...(await label(item.lastUser, item.afterExplanation, text)) });
  const out: Record<string, Awaited<ReturnType<typeof scored>>> = { original: await scored(turns[item.k].text) };
  for (const [name, variant] of Object.entries(variants)) out[name] = await scored(await reply(variant, history(turns, item.k, variant)));
  return { ...item, ...out };
});
writeFileSync(outPath, JSON.stringify(results, null, 2));

type Column = "original" | "A" | "B";
const rate = (name: Column, key: "endsWithQuestion" | "advises" | "interviews" | "flattery", rows = results.filter((r) => !r.feelsOff)) =>
  `${rows.filter((r) => (r as any)[name][key]).length}/${rows.length}`;
// original: what the twin actually said in prod (same judge), for scale.
for (const name of ["original", "A", "B"] as const) {
  const explained = results.filter((r) => r.afterExplanation);
  const words = results.map((r) => (r as any)[name].words as number).sort((x, y) => x - y);
  console.log(`${name}: ends with question ${rate(name, "endsWithQuestion")} · interviews ${rate(name, "interviews")} · flattery ${rate(name, "flattery")} · advises ${rate(name, "advises")} · redoes after feedback ${explained.filter((r) => (r as any)[name].redoes).length}/${explained.length} · median words ${words[Math.floor(words.length / 2)]}`);
}
console.log(`details: ${outPath}`);
