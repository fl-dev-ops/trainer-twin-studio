export const knowledgeKeys = {
  all: ["knowledge"] as const,
  documents: () => [...knowledgeKeys.all, "documents"] as const,
  stats: () => [...knowledgeKeys.all, "stats"] as const,
  connectors: () => [...knowledgeKeys.all, "connectors"] as const,
  search: (query: string) => [...knowledgeKeys.all, "search", query] as const,
};
