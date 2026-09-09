export const knowledgeKeys = {
  all: ["knowledge"] as const,
  documents: () => [...knowledgeKeys.all, "documents"] as const,
  stats: () => [...knowledgeKeys.all, "stats"] as const,
  search: (query: string) => [...knowledgeKeys.all, "search", query] as const,
  embeddings: (limit = 2000) => [...knowledgeKeys.all, "embeddings", limit] as const,
};
