export type KnowledgeDoc = {
  id: string;
  kbId: string;
  kbSlug: string;
  slug: string;
  title: string;
  ext: string;
  size: number;
  status: "uploaded" | "digesting" | "indexed" | "failed" | string;
  error: string | null;
  chunkCount?: number;
  indexedAt: string | null;
  createdAt: string;
};

export type KnowledgeStats = {
  totalDocs: number;
  totalChunks: number;
  totalPersonaMoments: number;
  lastIndexedAt: string | null;
  totalSizeBytes: number;
};

export type EmbeddingPoint3D = {
  id: string;
  x: number;
  y: number;
  z: number;
  type: "knowledge" | "persona_voice";
  title: string;
  source: string;
  docId?: string;
  personaId?: string;
  chunkIndex?: number;
  action?: string;
  preview: string;
};

export type KnowledgeSearchHit = {
  id: string;
  docId: string;
  kbId: string;
  source: string;
  text: string;
  score: number;
};

export type ViewMode = "list" | "3d";
