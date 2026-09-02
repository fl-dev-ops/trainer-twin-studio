# Chunking strategy

How TrainerTwin splits uploaded markdown into retrieval chunks before embedding and
indexing them into Chroma.

## Where it lives

- **Production:** `web/lib/knowledge.ts` — `chunkMarkdown(text, targetChars, maxChars)`
- **POC placeholder (not the studio path):** `synthesizer/poc/runner.py:358` splits on blank
  lines (`"\n\n"`) — the "ponytail" hashing path.

This document describes the production chunker only.

## The strategy in one line

A **hand-rolled, deterministic, structure-aware paragraph packer** — no library, no tokens,
no ML, no overlap.

It splits markdown into paragraphs, then packs paragraphs into chunks of roughly
`targetChars` (default **1200**) with a hard cap of `maxChars` (default **2000**), using
ATX headings as boundaries.

## Algorithm

```ts
function chunkMarkdown(text, targetChars = 1200, maxChars = 2000): string[] {
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);  // 1. paragraphs
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };

  for (let p of paras) {
    // 2. hard-split a single oversized paragraph at the last sentence boundary
    while (p.length > maxChars) {
      const cut = p.lastIndexOf(". ", maxChars);
      const at = cut > maxChars / 2 ? cut + 1 : maxChars;
      chunks.push(p.slice(0, at).trim());
      p = p.slice(at).trim();
    }
    const isHeading = /^#{1,6} /.test(p);                                 // 3. ATX heading?
    if (cur && ((isHeading && cur.length >= targetChars * 0.5)           // 4a. full + heading
              || cur.length + p.length > maxChars)) {                     // 4b. would overflow
      push();
    }
    cur = cur ? `${cur}\n\n${p}` : p;                                     // 5. glue in
  }
  push();
  return chunks;
}
```

### Three rules, in order

1. **Paragraph-split first** — split on blank lines (`\n{2,}`); a paragraph is the atomic unit.
2. **Hard-split oversized paragraphs** — a paragraph over `maxChars` is cut at the last
   `". "` before the cap; if that boundary is before the halfway point, cut mid-sentence at
   the cap.
3. **Pack with a heading trigger** — accumulate paragraphs until either:
   - a `#`-heading appears **and** the current chunk is already ≥ `targetChars * 0.5` (600), or
   - adding the paragraph would exceed `maxChars`.

## The two knobs

| Param        | Default | Meaning                                             |
|--------------|---------|-----------------------------------------------------|
| `targetChars`| 1200    | soft target — chunks aim to be ~1200 chars          |
| `maxChars`   | 2000    | hard cap — never exceeded except by an oversized paragraph |

## Header and body

There is **no separate header field**. The "header" is simply the raw `#`-heading line that
happens to become the first line of a chunk; the body is the paragraphs packed after it.

```
# Frontend fundamentals reference          ← "header" = raw `#` line, kept verbatim
JavaScript executes synchronous code…      ← body = packed non-heading paragraphs
React reconciliation compares element…     ←  (separated by one blank line each)
API gateway caching can reduce…            ←  (until ~1200 chars / a heading / 2000)
```

What that means concretely:

- The `#`/`##` symbols are **kept verbatim** in the chunk text and therefore in the embedding.
- A heading **starts a new chunk** only when the current chunk already has ≥ 600 chars;
  otherwise it is glued into the current chunk (a `##` subheading stays with its parent).
- Headings are **not propagated** to continuation chunks — if one section spans two chunks,
  only the first chunk carries the title.
- Metadata stored with each chunk is `{ docId, source, chunkIndex, chunkCount }`. There is no
  `section`, `heading`, or `path` field.
- Only ATX headings (`#` … `###### `) are recognized; setext underlines (`Title\n=====`) are
  treated as plain paragraphs.

## Summaries

**No summaries are used anywhere in the chunking or indexing path.**

- `chunkMarkdown` returns plain `string[]` — raw text only.
- `ingestDoc` stores the chunk text as-is in Chroma's `documents` field with
  `{ docId, source, chunkIndex, chunkCount }` metadata — no summary field, no summary embedding,
  no title field.
- The chunks themselves are embedded whole (`embedTexts(chunks)`); there is no
  summary-then-embed or two-stage (summary + content) representation.

## Worked example

`data/knowledge/software-engineering/frontend-fundamentals.md` (7 lines: one `#` heading +
three dense paragraphs) becomes **one chunk** of ~1113 chars: heading (33) + paragraph
(≈390) + paragraph (≈360) + paragraph (≈330). It never reaches `targetChars` (1200), has a
single heading, and none of the paragraphs exceed `maxChars` (2000).

## Characteristics vs. common alternatives

| Dimension                | This chunker                                   |
|--------------------------|------------------------------------------------|
| Overlap                  | none — chunks are disjoint                     |
| Measurement              | characters, not tokens                         |
| Semantics                | none — no embedding/LLM pass decides the cut   |
| Heading metadata         | none — headings live inline, not in metadata   |
| Hierarchical propagation | none — sub-chunks don't inherit the section    |
| Tables / code fences     | not specially handled                          |

## Known limitations

1. **No header propagation** — a retrieved continuation chunk can look context-free.
2. **`#` symbols embedded** — raw heading markers are part of the vector.
3. **Limited metadata** — chunk order/count is stored, but there is no section/path metadata.
4. **Setext headings ignored** — only `#`-style headings are treated as boundaries.
5. **No overlap** — a fact straddling a boundary is split.

## When it stops being enough

- The BM25 arm currently runs over all chunks client-side (`knowledge.ts:180` "ponytail"):
  fine under ~10k chunks, needs a real lexical index beyond that.
- If recall suffers from context-free continuation chunks, add header propagation or a
  `header` metadata field — this would mean `chunkMarkdown` returning `{text, header}` pairs
  and `ingestDoc` storing `header` in metadata.
