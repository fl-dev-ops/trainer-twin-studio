import type {
  ConnectorInfo,
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

export async function fetchConnectors(): Promise<ConnectorInfo> {
  const res = await fetch("/api/knowledge/connectors");
  if (!res.ok) throw new Error("Failed to fetch connectors");
  return res.json();
}

export async function searchKnowledge(query: string): Promise<KnowledgeSearchHit[]> {
  const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Search failed");
  return data.hits ?? [];
}

