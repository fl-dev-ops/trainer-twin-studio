import type {
  EmbeddingPoint3D,
  KnowledgeDoc,
  KnowledgeSearchHit,
  KnowledgeStats,
} from "@/components/knowledge/types";

export async function fetchDocuments(): Promise<KnowledgeDoc[]> {
  const res = await fetch("/api/knowledge/documents");
  if (!res.ok) throw new Error("Failed to fetch documents");
  const data = await res.json();
  return data.documents ?? [];
}

export async function fetchStats(): Promise<KnowledgeStats> {
  const res = await fetch("/api/knowledge/stats");
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export async function searchKnowledge(query: string): Promise<KnowledgeSearchHit[]> {
  const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Search failed");
  return data.hits ?? [];
}

export async function fetchEmbeddings(
  limit = 2000,
  refresh = false,
): Promise<{
  points: EmbeddingPoint3D[];
  stats: { totalPoints: number; knowledgePoints: number; personaVoicePoints: number };
}> {
  const url = `/api/knowledge/embeddings?limit=${limit}${refresh ? "&refresh=true" : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch embeddings");
  return res.json();
}
