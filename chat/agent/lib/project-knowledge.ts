/**
 * Knowledge-base grounding for technical follow-ups on the current resume project. Looked up once
 * per project (2–3 s) inside start_resume_question, while the question is already being spoken,
 * and compacted into the per-turn plan block — so follow-ups never wait for it.
 */
const SHARED_KNOWLEDGE_BASE_SLUG = "acme-knowledge";

/** PROJECT_KNOWLEDGE=off skips both the lookup and the plan-block section (for latency comparisons). */
export const projectKnowledgeEnabled = () => process.env.PROJECT_KNOWLEDGE?.trim().toLowerCase() !== "off";
const HITS = 3;
const EXCERPT_CHARS = 350;

export type ProjectKnowledge = { claimId: string; snippets: string[] };

type Hit = { title?: string; text?: string };
type Fetch = <T>(payload: Record<string, unknown>) => Promise<T>;

/** "title — topic: excerpt", without the chunk's Page/Topic header lines. */
export function compactKnowledgeHit(hit: Hit): string {
  const lines = (hit.text ?? "").split("\n");
  const topic = lines.find((line) => line.startsWith("Topic:"))?.replace(/^Topic:\s*/, "").split(" > ").slice(-2).join(" > ");
  const body = lines.filter((line) => !/^(Page|Topic):/.test(line)).join(" ").replace(/\s+/g, " ").trim();
  const label = [hit.title, topic].filter(Boolean).join(" — ");
  return `${label}: ${body.slice(0, EXCERPT_CHARS)}`.trim();
}

export async function fetchProjectKnowledge(claimId: string, query: string, fetch: Fetch): Promise<ProjectKnowledge | null> {
  const result = await fetch<{ relevant?: boolean; results?: Hit[] }>({
    action: "searchKnowledge",
    knowledgeBase: SHARED_KNOWLEDGE_BASE_SLUG,
    query: query.slice(0, 500),
    limit: HITS,
  }).catch(() => null);
  if (!result?.relevant || !result.results?.length) return null;
  const snippets = result.results.map(compactKnowledgeHit).filter((snippet) => snippet.length > 20);
  return snippets.length ? { claimId, snippets } : null;
}
