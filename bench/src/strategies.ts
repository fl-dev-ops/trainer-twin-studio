// Chunking strategies under test.
//
// `structural-*` reuses the exact production chunker (web/lib/knowledge.ts) so the
// baseline column of the report is the real system, not a lookalike. Other
// strategies are bench-local implementations of common alternatives.
import { RecursiveChunker } from "@chonkiejs/core";
import { chunkMarkdown as productionChunkMarkdown, embedTexts } from "../../web/lib/knowledge";
import { chunkWithHeadingContext } from "./heading-context";

export type BenchChunk = { text: string };

export type Strategy = {
  name: string;
  description: string;
  /** True when the strategy needs an embedding pass at chunking time (costed separately). */
  embedsAtChunkTime?: boolean;
  run(markdown: string): Promise<BenchChunk[]>;
};

const toChunks = (texts: string[]): BenchChunk[] => texts.map((text) => ({ text }));

function structural(targetChars: number): Strategy {
  return {
    name: `structural-${targetChars}`,
    description: `production chunkMarkdown(target=${targetChars})`,
    run: async (md) => toChunks(productionChunkMarkdown(md, targetChars, Math.round(targetChars * 5 / 3))),
  };
}

/** Production-style packing, but every context-free chunk (continuations AND hard-split
 * pieces) is prefixed with the nearest preceding ATX heading — fixes CHUNKING_STRATEGY.md
 * limitation #1. */
async function headerContext(md: string, targetChars = 1200, maxChars = 2000): Promise<BenchChunk[]> {
  const paras = md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  let lastHeading = "";
  const contextual = (text: string): string =>
    !text || /^#{1,6} /.test(text) || !lastHeading ? text : `## ${lastHeading}\n\n${text}`;
  const emitPacked = () => {
    if (!cur.trim()) return;
    out.push(contextual(cur.trim()));
    cur = "";
  };
  for (let p of paras) {
    const headingMatch = /^#{1,6} (.+)$/m.exec(p);
    if (headingMatch) lastHeading = headingMatch[1].trim();
    while (p.length > maxChars) {
      const cut = p.lastIndexOf(". ", maxChars);
      const at = cut > maxChars / 2 ? cut + 1 : maxChars;
      out.push(contextual(p.slice(0, at).trim()));
      p = p.slice(at).trim();
    }
    const isHeading = /^#{1,6} /.test(p);
    if (cur && ((isHeading && cur.length >= targetChars * 0.5) || cur.length + p.length > maxChars)) emitPacked();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  emitPacked();
  return out.map((text) => ({ text }));
}

/** Classic LangChain-style recursive splitter over a separator hierarchy. */
function recursiveChar(md: string, targetChars = 800, maxChars = 1200): string[] {
  const separators = ["\n\n", "\n", ". ", " ", ""];
  function split(text: string, level: number): string[] {
    if (text.length <= maxChars) return [text];
    if (level >= separators.length) {
      const out: string[] = [];
      for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
      return out;
    }
    const sep = separators[level];
    const parts = sep ? text.split(sep) : [text];
    const chunks: string[] = [];
    let cur = "";
    for (const part of parts) {
      const candidate = cur ? `${cur}${sep}${part}` : part;
      if (cur && candidate.length > targetChars) {
        chunks.push(cur);
        cur = part;
      } else {
        cur = candidate;
      }
      while (cur.length > maxChars) {
        chunks.push(cur.slice(0, maxChars));
        cur = cur.slice(maxChars);
      }
    }
    if (cur.trim()) chunks.push(cur);
    return chunks;
  }
  return split(md, 0).map((c) => c.trim()).filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9#*-])|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Sliding sentence window with one-sentence overlap — tests whether boundary-straddling facts hurt. */
async function sentenceOverlap(md: string, targetChars = 800): Promise<BenchChunk[]> {
  const sentences = splitSentences(md);
  const chunks: string[] = [];
  let window: string[] = [];
  let length = 0;
  const flush = () => {
    if (!window.length) return;
    chunks.push(window.join(" "));
    // keep the last sentence as overlap for the next chunk
    const last = window[window.length - 1];
    window = last.length < targetChars / 2 ? [last] : [];
    length = window.reduce((a, s) => a + s.length + 1, 0);
  };
  for (const sentence of sentences) {
    if (length + sentence.length > targetChars && window.length > 1) flush();
    window.push(sentence);
    length += sentence.length + 1;
  }
  flush();
  return toChunks(chunks.filter((c) => c.length > 40));
}

async function chonkieRecursive(md: string, size = 512): Promise<BenchChunk[]> {
  const chunker = await RecursiveChunker.create({ chunkSize: size, minCharactersPerChunk: 48 });
  const chunks = await chunker.chunk(md);
  return toChunks(chunks.map((chunk: { text: string }) => chunk.text));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Embedding-based semantic chunker (the classic percentile algorithm).
 * NOTE: @chonkiejs/core does not ship SemanticChunker (Python-only), so this is a
 * bench-local equivalent: sentences are embedded once with the production embedding
 * model, then adjacent sentences merge while their similarity stays above threshold.
 */
async function semantic(md: string, threshold = 0.55, maxChars = 1800): Promise<BenchChunk[]> {
  const sentences = splitSentences(md).flatMap((s) => (s.length > 1200 ? splitSentences(s.replace(/([.!?]) /g, "$1\u0000")).flatMap((t) => t.split("\u0000")) : [s]));
  if (sentences.length === 0) return [];
  const vectors = await embedTexts(sentences);
  const chunks: BenchChunk[] = [];
  let group: string[] = [sentences[0]];
  let prevVector = vectors[0];
  const flushGroup = () => {
    chunks.push({ text: group.join("\n") });
    group = [];
  };
  for (let i = 1; i < sentences.length; i++) {
    const sim = cosine(prevVector, vectors[i]);
    const projectedLength = group.reduce((a, s) => a + s.length + 1, 0) + sentences[i].length;
    if ((sim < threshold || projectedLength > maxChars) && group.join("\n").length > 80) {
      flushGroup();
    }
    group.push(sentences[i]);
    prevVector = vectors[i];
  }
  if (group.length) flushGroup();
  return chunks;
}

export const STRATEGIES: Strategy[] = [
  structural(600),
  structural(1200),
  structural(2000),
  {
    name: "structural-context-2000",
    description: "heading-aware paragraph packing with Page/Topic labels on continuations (max 3333 chars including context)",
    run: async (md) => toChunks(chunkWithHeadingContext(md)),
  },
  {
    name: "header-context-1200",
    description: "production packing + nearest-heading propagated onto every continuation chunk",
    run: (md) => headerContext(md, 1200, 2000),
  },
  {
    name: "recursive-char-800",
    description: "LangChain-style recursive character split (\\n\\n > \\n > '. ' > ' '), target 800",
    run: async (md) => toChunks(recursiveChar(md)),
  },
  {
    name: "sentence-overlap-800",
    description: "sliding sentence window (~800 chars) with one-sentence overlap",
    run: (md) => sentenceOverlap(md),
  },
  {
    name: "chonkie-recursive-512",
    description: "@chonkiejs/core RecursiveChunker at 512 char-tokens",
    run: (md) => chonkieRecursive(md),
  },
  {
    name: "semantic-0.55",
    description: "embedding-based semantic merge of adjacent sentences (threshold 0.55, production embeddings)",
    embedsAtChunkTime: true,
    run: (md) => semantic(md),
  },
];

export function selectStrategies(filter?: string): Strategy[] {
  if (!filter || filter === "all") return STRATEGIES;
  const wanted = new Set(filter.split(",").map((s) => s.trim()));
  const picked = STRATEGIES.filter((s) => wanted.has(s.name));
  if (picked.length === 0) throw new Error(`no strategies matched: ${filter}`);
  return picked;
}
