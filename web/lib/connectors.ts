import { db } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";
import { deletePrefix, kbPrefix } from "@/lib/s3";
import { invalidateOrgKnowledgeCache, OrganizationKnowledgeService, getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";
import { queueNotionSync } from "@/lib/notion-ingestion";
import { queueYouTubeSync } from "@/lib/youtube-ingestion";

export type ConnectorsOverview = {
  notion: {
    configured: boolean;
    connections: {
      id: string;
      workspaceId: string;
      workspaceName: string | null;
      workspaceIcon: string | null;
      createdAt: Date;
    }[];
  };
  youtube: {
    configured: boolean;
    connections: {
      id: string;
      channelId: string;
      channelTitle: string;
      status: string;
      createdAt: Date;
    }[];
  };
  sources: {
    id: string;
    connector: string;
    externalId: string;
    sourceUrl: string;
    status: string;
    error: string | null;
    lastSyncedAt: Date | null;
    createdAt: Date;
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

/** Retrieves high-level connector status, active connections, and configured sources for an org. */
export async function getConnectorsOverview(orgId: string, kbIdOrSlug?: string): Promise<ConnectorsOverview> {
  let kbId: string;
  if (kbIdOrSlug) {
    const kb = await db.knowledgeBase.findFirst({
      where: { OR: [{ id: kbIdOrSlug }, { slug: kbIdOrSlug }], orgId },
      select: { id: true },
    });
    kbId = kb ? kb.id : (await getOrCreateOrgKnowledgeBase(orgId)).id;
  } else {
    kbId = (await getOrCreateOrgKnowledgeBase(orgId)).id;
  }

  const [notionConnections, youtubeConnections, sources] = await Promise.all([
    db.notionConnection.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        workspaceId: true,
        workspaceName: true,
        workspaceIcon: true,
        createdAt: true,
      },
    }),
    db.youTubeConnection.findMany({
      where: { orgId, status: { not: "disconnected" } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        channelId: true,
        channelTitle: true,
        status: true,
        createdAt: true,
      },
    }),
    db.knowledgeSource.findMany({
      where: { orgId, kbId },
      orderBy: { createdAt: "desc" },
      include: {
        documents: { select: { id: true } },
        jobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            stage: true,
            error: true,
            itemsDiscovered: true,
            itemsProcessed: true,
          },
        },
      },
    }),
  ]);

  const notionConfigured = Boolean(
    process.env.NOTION_OAUTH_CLIENT_ID?.trim() && process.env.NOTION_OAUTH_CLIENT_SECRET?.trim()
  );

  const youtubeConfigured = [
    "YOUTUBE_OAUTH_CLIENT_ID",
    "YOUTUBE_OAUTH_CLIENT_SECRET",
    "YOUTUBE_OAUTH_REDIRECT_URI",
    "YOUTUBE_TOKEN_ENCRYPTION_KEY",
  ].every((name) => Boolean(process.env[name]?.trim()));

  return {
    notion: {
      configured: notionConfigured,
      connections: notionConnections,
    },
    youtube: {
      configured: youtubeConfigured,
      connections: youtubeConnections,
    },
    sources: sources.map((s) => ({
      id: s.id,
      connector: s.connector,
      externalId: s.externalId,
      sourceUrl: s.sourceUrl,
      status: s.status,
      error: s.error,
      lastSyncedAt: s.lastSyncedAt,
      createdAt: s.createdAt,
      documentCount: s.documents.length,
      activeJob: s.jobs[0] ?? null,
    })),
  };
}

/** Refreshes an existing source by queuing a fresh crawl / ingestion job. */
export async function refreshSource(orgId: string, userId: string, sourceId: string) {
  const source = await db.knowledgeSource.findFirst({
    where: { id: sourceId, orgId },
    include: {
      notion: true,
      youtube: true,
      documents: { take: 1, select: { id: true } },
    },
  });

  if (!source) throw new Error("Knowledge source not found");

  if (source.connector === "upload") {
    if (source.documents.length === 0) throw new Error("No uploaded file found for source");
    return OrganizationKnowledgeService.reindexDocument(orgId, source.documents[0].id);
  }

  if (source.connector === "notion" || source.connector === "notion_public") {
    if (source.connector === "notion_public") {
      return queueNotionSync({
        orgId,
        userId,
        kbId: source.kbId,
        mode: "public",
        url: source.sourceUrl,
      });
    }
    if (!source.notion?.connectionId) throw new Error("Notion connection missing on source");
    return queueNotionSync({
      orgId,
      userId,
      kbId: source.kbId,
      mode: "oauth",
      url: source.sourceUrl,
      connectionId: source.notion.connectionId,
    });
  }

  if (source.connector === "youtube") {
    if (!source.youtube?.connectionId) throw new Error("YouTube connection missing on source");
    return queueYouTubeSync({
      orgId,
      userId,
      kbId: source.kbId,
      url: source.sourceUrl,
      connectionId: source.youtube.connectionId,
      refresh: true,
    });
  }

  throw new Error(`Unsupported source connector: ${source.connector}`);
}

/**
 * Deletes a source and all associated documents, vectors, and S3 artifacts.
 * Cancels any active jobs before deletion to prevent workers from republishing.
 */
export async function deleteSource(orgId: string, sourceId: string) {
  const source = await db.knowledgeSource.findFirst({
    where: { id: sourceId, orgId },
    include: {
      documents: {
        select: { id: true, kbId: true },
      },
    },
  });

  if (!source) throw new Error("Knowledge source not found");

  // 1. Cancel active jobs and work items
  await db.ingestionWorkItem.updateMany({
    where: {
      job: { sourceId: source.id },
      status: { in: ["queued", "running"] },
    },
    data: { status: "failed", error: "Source deleted" },
  });

  await db.ingestionJob.updateMany({
    where: {
      sourceId: source.id,
      status: { in: ["queued", "running"] },
    },
    data: {
      status: "failed",
      error: "Source deleted",
      activeKey: null,
      finishedAt: new Date(),
    },
  });

  // 2. Delete document vectors and S3 objects for each document
  for (const doc of source.documents) {
    await Promise.all([
      MainCollectionService.removeKnowledgeDoc(orgId, doc.id).catch((err) => {
        console.error(`Failed to remove document ${doc.id} from Chroma:`, err);
        throw err;
      }),
      deletePrefix(kbPrefix(orgId, doc.kbId, doc.id)).catch((err) => {
        console.error(`Failed to remove S3 prefix for doc ${doc.id}:`, err);
      }),
    ]);
  }

  // 3. Delete database records
  await db.knowledgeDocument.deleteMany({
    where: { sourceId: source.id },
  });

  await db.knowledgeSource.delete({
    where: { id: source.id },
  });

  invalidateOrgKnowledgeCache(orgId);
  return { ok: true, deletedSourceId: source.id, deletedDocCount: source.documents.length };
}

/**
 * Disconnects an integration (Notion or YouTube).
 * Deletes dependent sources, documents, S3 artifacts, Chroma chunks, and connection credentials.
 */
export async function deleteConnection(
  orgId: string,
  connectionId: string,
  provider?: "notion" | "youtube",
) {
  // Determine provider if not explicitly given
  let resolvedProvider = provider;
  if (!resolvedProvider) {
    const [hasNotion, hasYouTube] = await Promise.all([
      db.notionConnection.findFirst({ where: { id: connectionId, orgId }, select: { id: true } }),
      db.youTubeConnection.findFirst({ where: { id: connectionId, orgId }, select: { id: true } }),
    ]);
    if (hasNotion) resolvedProvider = "notion";
    else if (hasYouTube) resolvedProvider = "youtube";
    else throw new Error("Connection not found");
  }

  // 1. Find all dependent sources
  let dependentSources: { id: string }[] = [];
  if (resolvedProvider === "notion") {
    dependentSources = await db.knowledgeSource.findMany({
      where: { orgId, notion: { connectionId } },
      select: { id: true },
    });
  } else if (resolvedProvider === "youtube") {
    dependentSources = await db.knowledgeSource.findMany({
      where: { orgId, youtube: { connectionId } },
      select: { id: true },
    });
  }

  // 2. Delete each dependent source (which cleans up jobs, chunks, S3, documents)
  for (const src of dependentSources) {
    await deleteSource(orgId, src.id);
  }

  // 3. Delete the connection record
  if (resolvedProvider === "notion") {
    await db.notionConnection.deleteMany({
      where: { id: connectionId, orgId },
    });
  } else if (resolvedProvider === "youtube") {
    await db.youTubeConnection.deleteMany({
      where: { id: connectionId, orgId },
    });
  }

  invalidateOrgKnowledgeCache(orgId);
  return { ok: true, connectionId, deletedSourceCount: dependentSources.length };
}
