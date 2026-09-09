# ChromaDB Retrieval Procedure & LLM Guidance

This document defines the retrieval, filtering, parsing, and LLM orchestration contract for accessing knowledge chunks stored in ChromaDB (`kb_engineering`).

---

## 1. ChromaDB Collection Specification

| Parameter | Value |
|---|---|
| **Tenant** | `7d223ee7-7193-4179-95a6-0a1092f920e3` |
| **Database** | `trainer-twin` |
| **Collection** | `kb_engineering` |
| **Embedding Model** | `openai/text-embedding-3-small` (1536 dimensions) |
| **Distance Metric** | Cosine (`defaultSpace: "cosine"`) |

---

## 2. Ingested Data Modalities

Chunks in `kb_engineering` originate from two distinct sources:

| Source | Ingestion Strategy | Stored Document Structure | Question Availability |
|---|---|---|---|
| **YouTube Transcripts** | `youtube-substantive-questions-v1` | Explicit spoken questions: *"What is reconciliation in React?"* | **Available directly** in chunk text. |
| **Notion Cohort Notes** | `structural-context-2000-v1` | Declarative study notes, code blocks, comparison tables, and architecture guidelines. | **Not available directly**. The LLM must synthesize the question from the topic context and notes. |

---

## 3. Query Construction (What to Query)

### A. Initial Plan Retrieval
- **Do not query conversational sentences** (e.g. avoid *"Can you ask the candidate a question about React?"*).
- **Query focused technical concept clusters**:
  - `React fundamentals`: `"React rendering virtual DOM reconciliation state updates hooks"`
  - `JavaScript fundamentals`: `"JavaScript execution context event loop microtask closure"`
  - `Browser & Web`: `"Browser rendering pipeline DOM events security XSS CSRF"`
  - `APIs & Networking`: `"HTTP request response WebSockets SSE API gateway rate limiting"`
  - `Performance`: `"Web Vitals LCP CLS FID bundle optimization tree shaking"`

### B. Dynamic Follow-up Probing
When a candidate gives an incomplete or surface-level answer:
- Extract **2 to 4 technical mechanism keywords** from their answer or the omitted detail:
  - Example: `["microtask queue", "event loop", "Promise execution order"]`
  - Example: `["reconciliation", "Fiber tree", "batching"]`
- Pass `excludeIds` containing all chunk IDs already asked or retrieved during the session.

---

## 4. Chunk Filtering & Sanitation (How to Filter)

Before passing chunks to the LLM or interview agenda, apply the following deterministic filters:

1. **Drop Recording / Media Placeholders**:
   - Chunks matching `/Session \d+ [Rr]ecording/i` that contain no `Topic:` breadcrumb or `##` heading are raw video links and must be dropped.
2. **Enforce Length Cutoff**:
   - Discard chunks with text length `< 25` characters.
3. **Deduplicate by Topic**:
   - Prevent asking multiple chunks on the exact same sub-topic within an initial plan by tracking normalized topic slugs (`topics` array in metadata).
4. **Distance Threshold**:
   - Cosine distance `< 0.55`: High confidence relevance.
   - Cosine distance `0.55 - 0.70`: Acceptable for broad topics.
   - Cosine distance `> 0.70`: Weak match; fallback to agenda or broader query.

---

## 5. Topic Extraction Contract

To avoid pulling internal bullet points (e.g. `#### ❌ Bad approach`) as the question title, extraction must follow strict priority order:

```text
1. Explicit Topic Breadcrumb  ──> match(/^Topic:\s*([^\n]+)/m)
2. Main Heading (H1/H2)       ──> match(/^#{1,2}\s+([^\n]+)/m)
3. Direct Question Line       ──> First line containing "?" (length 10–150)
4. Subheading (H3)            ──> match(/^###\s+([^\n]+)/m)
5. Fallback                   ──> pageTitle from metadata
```

### Hierarchy Cleaning
- Normalize arrow separators (`>` or `→`) to dashes (`—`).
- Strip markdown symbols and leading bullets (`*`, `-`, `#`).

---

## 6. Prompt Instructions for the Interviewer LLM

When feeding ChromaDB chunks to an interviewer LLM (e.g. Vasanth), the system prompt must enforce the following rules:

### A. Question Formulation from Declarative Chunks
- **The chunk provides ground truth, not a verbatim script.**
- If the item is a declarative topic (e.g. `"Different hooks — Avoid unnecessary re-renders (useRef vs useState)"`):
  - **Instruct the LLM**: Formulate an open-ended verbal question that challenges the candidate to explain the *underlying mechanism* rather than asking for a textbook definition.
  - *Good*: *"When dealing with a timer or interval ID in React, why does storing it in state cause unnecessary re-renders, and how does useRef solve this?"*
  - *Bad*: *"What is the bad approach with state?"*

### B. Anti-Pattern & "Bad Code" Chunks
Notion chunks frequently contrast an anti-pattern (`❌ Bad approach`) with a recommended pattern (`✅ Correct approach`):
- **Instruct the LLM**: Frame the question around trade-offs and failure modes.
- Ask the candidate:
  1. Why the naive pattern fails under load or at scale.
  2. What mechanism makes the recommended pattern safer or faster.

### C. Evaluation Against Chunk Ground Truth
- The chunk's text (code examples, performance numbers, caveats) serves as the **grading rubric**.
- The interviewer must verify whether the candidate articulated the core mechanism (e.g. queue priority, memory reference, batching schedule) found in the chunk.
- If the candidate misses the core mechanism, query Chroma for a follow-up probe using the omitted keyword.

### D. Leakage Prevention
- **Strictly prohibit** the LLM from outputting:
  - Chunk IDs (e.g. `0d10373c...#7`)
  - Cosine distance scores
  - JSON metadata or database field names
  - Reading the raw study notes directly to the candidate
