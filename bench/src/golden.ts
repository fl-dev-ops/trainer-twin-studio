// Step 2: generate the golden QA dataset without human labeling.
//
// Method: split the fixture into fine-grained passages (production chunker at a
// small target), pick N evenly spaced passages, and ask an LLM to write one
// question per passage whose answer is contained ONLY in that passage. The source
// passage becomes the gold span used for relevance matching at eval time.
//
// The output is committed to git so every future benchmark run answers identical
// questions — that's what makes runs comparable across time.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./env";
import { chunkMarkdown } from "../../web/lib/knowledge";
import { llmJson } from "./llm";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../fixtures/page.md");
const goldenDir = resolve(here, "../golden");

const PASSAGE_TARGET = 400;

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

type GoldenItem = { id: string; question: string; answer: string; goldSpan: string };

async function main() {
  const count = Number(argValue("--count") ?? 20);
  const markdown = readFileSync(fixturePath, "utf8");

  // Fine-grained passages via the production packer at a small target.
  const passages = chunkMarkdown(markdown, PASSAGE_TARGET, 700).filter((p) => p.length >= 150);
  console.info(`${passages.length} fine-grained passages from fixture (${markdown.length} chars)`);

  // Evenly spaced sample keeps coverage across the whole document.
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(passages.length - 1, Math.floor(((i + 0.5) / count) * passages.length));
    if (!picked.includes(passages[index])) picked.push(passages[index]);
  }
  console.info(`picked ${picked.length} passages -> generating questions`);

  const items: GoldenItem[] = [];
  const BATCH = 5;
  for (let start = 0; start < picked.length; start += BATCH) {
    const batch = picked.slice(start, start + BATCH);
    const listing = batch.map((passage, i) => `<passage index="${i}">\n${passage.slice(0, 1500)}\n</passage>`).join("\n");
    const result = (await llmJson(
      "You create retrieval-evaluation questions. For each passage, write ONE specific question that a trainer studying this material would ask, such that the answer is fully contained in that passage and in no other obvious place. Questions must be self-contained (understandable without seeing the passage). Do not use pronouns referring to 'the document'.",
      `${listing}\n\nRespond as JSON: {"items":[{"index":0,"question":"...","answer":"..."}]} with one item per passage index.`,
    )) as { items?: { index?: number; question?: string; answer?: string }[] };

    for (const entry of Array.isArray(result.items) ? result.items : []) {
      if (typeof entry.index !== "number" || !entry.question || !entry.answer) continue;
      const passage = batch[entry.index];
      if (!passage) continue;
      items.push({
        id: `q${items.length + 1}`,
        question: entry.question.trim(),
        answer: entry.answer.trim(),
        goldSpan: passage,
      });
    }
    console.info(`generated ${items.length}/${picked.length} questions`);
  }

  if (items.length === 0) throw new Error("No questions generated");
  mkdirSync(goldenDir, { recursive: true });
  const out = {
    createdAt: new Date().toISOString(),
    model: process.env.JUDGE_MODEL ?? process.env.TOPIC_MODEL ?? "openai/gpt-4o-mini",
    fixtureChars: markdown.length,
    passagesTotal: passages.length,
    items,
  };
  writeFileSync(join(goldenDir, "questions.json"), JSON.stringify(out, null, 2), "utf8");
  console.info(`wrote golden/questions.json with ${items.length} items`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
