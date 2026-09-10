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
  sourceId?: string | null;
  connector?: "upload" | "notion" | "notion_public" | "youtube" | string;
  sourceStatus?: string | null;
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

export type ConnectorInfo = {
  notion: {
    configured: boolean;
    connections: {
      id: string;
      workspaceId: string;
      workspaceName: string | null;
      workspaceIcon: string | null;
      createdAt: string;
    }[];
  };
  youtube: {
    configured: boolean;
    connections: {
      id: string;
      channelId: string;
      channelTitle: string;
      status: string;
      createdAt: string;
    }[];
  };
  sources: {
    id: string;
    connector: string;
    externalId: string;
    sourceUrl: string;
    status: string;
    error: string | null;
    lastSyncedAt: string | null;
    createdAt: string;
    documentCount: number;
    activeJob?: {
      id: string;
      status: string;
      stage: string | null;
      error: string | null;
      itemsDiscovered: number;
      itemsProcessed: number;
    } | null;
  }[];
};
