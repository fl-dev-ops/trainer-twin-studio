import { db } from "@/lib/db";
import { parseYouTubeVideoId, type YouTubeImportInput } from "@/lib/youtube";
import { enqueueIngestionWork } from "@/lib/ingestion-queue";
import { youtubeClient } from "@/lib/youtube-server";
import { YouTubeError } from "@shared/youtube/types";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";

type ImportContext = { orgId: string; userId: string; kbId?: string; kbSlug?: string };

async function resolveKnowledgeBase(orgId: string, kbId?: string, kbSlug?: string) {
  if (kbId) {
    const kb = await db.knowledgeBase.findFirst({ where: { id: kbId, orgId }, select: { id: true, slug: true } });
    if (kb) return kb;
  }
  if (kbSlug) {
    const kb = await db.knowledgeBase.findFirst({ where: { slug: kbSlug, orgId }, select: { id: true, slug: true } });
    if (kb) return kb;
  }
  return getOrCreateOrgKnowledgeBase(orgId);
}

async function verifyActiveConnection(orgId: string, connectionId: string) {
  const connection = await db.youTubeConnection.findFirst({
    where: { id: connectionId, orgId, status: "active" },
    select: { id: true, userId: true, channelTitle: true },
  });
  if (!connection) {
    throw new YouTubeError("RECONNECT_REQUIRED", "Connect your YouTube channel before importing");
  }
  return connection;
}

/** Returns connection metadata and import jobs for the knowledge base. */
export async function listYouTubeImports(orgId: string, kbIdOrSlug?: string) {
  let kbId: string | undefined;
  if (kbIdOrSlug) {
    const kb = await db.knowledgeBase.findFirst({
      where: { OR: [{ id: kbIdOrSlug }, { slug: kbIdOrSlug }], orgId },
      select: { id: true },
    });
    kbId = kb?.id;
  } else {
    const defaultKb = await db.knowledgeBase.findFirst({
      where: { orgId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    kbId = defaultKb?.id;
  }

  const [connections, jobs] = await Promise.all([
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
    kbId
      ? db.ingestionJob.findMany({
          where: {
            source: {
              orgId,
              kbId,
              connector: "youtube",
            },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            status: true,
            stage: true,
            error: true,
            createdAt: true,
            finishedAt: true,
            source: {
              select: {
                id: true,
                externalId: true,
                youtube: { select: { connectionId: true } },
              },
            },
            workItems: {
              where: { kind: "segment" },
              select: { status: true },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const configured = [
    "YOUTUBE_OAUTH_CLIENT_ID",
    "YOUTUBE_OAUTH_CLIENT_SECRET",
    "YOUTUBE_OAUTH_REDIRECT_URI",
    "YOUTUBE_TOKEN_ENCRYPTION_KEY",
  ].every((name) => Boolean(process.env[name]?.trim()));

  return {
    configured,
    connections,
    jobs: jobs.map(({ source, workItems, ...job }) => ({
      ...job,
      sourceId: source.id,
      videoId: source.externalId,
      connectionId: source.youtube?.connectionId ?? null,
      segmentsTotal: workItems.length,
      segmentsSucceeded: workItems.filter((item) => item.status === "succeeded").length,
      segmentsFailed: workItems.filter((item) => item.status === "failed").length,
    })),
  };
}

/** Preview uses owner credentials on the server; worker rechecks independently. */
export async function previewYouTubeImport(input: ImportContext & YouTubeImportInput) {
  const kb = await resolveKnowledgeBase(input.orgId, input.kbId, input.kbSlug);
  const connection = await verifyActiveConnection(input.orgId, input.connectionId);
  const videoId = parseYouTubeVideoId(input.url);
  if (!videoId) throw new YouTubeError("INVALID_URL", "Invalid YouTube video URL");

  const scope = { connectionId: connection.id, orgId: input.orgId, userId: connection.userId };
  const video = await youtubeClient().inspectOwnedVideo(scope, videoId);
  const existing = await db.knowledgeDocument.findFirst({
    where: {
      kbId: kb.id,
      externalId: videoId,
      status: "indexed",
      source: { connector: "youtube", youtube: { connectionId: input.connectionId } },
    },
    select: { id: true },
  });

  return { ...video, alreadyIndexed: Boolean(existing) };
}

/** Persists one video job using the connector-neutral enqueueIngestionWork boundary. */
export async function queueYouTubeSync(input: ImportContext & YouTubeImportInput) {
  const startedAt = Date.now();
  console.info(`[JOB:youtube-enqueue] start url=${input.url}`);
  try {
    const videoId = parseYouTubeVideoId(input.url);
    if (!videoId) throw new YouTubeError("INVALID_URL", "Invalid YouTube video URL");

    const kb = await resolveKnowledgeBase(input.orgId, input.kbId, input.kbSlug);
    await verifyActiveConnection(input.orgId, input.connectionId);

    // If not a force refresh, check if already indexed
    if (!input.refresh) {
      const indexed = await db.knowledgeDocument.findFirst({
        where: {
          kbId: kb.id,
          externalId: videoId,
          status: "indexed",
          source: { connector: "youtube" },
        },
        select: { id: true },
      });
      if (indexed) {
        return { alreadyIndexed: true, documentId: indexed.id, status: "indexed" };
      }
    }

    const result = await enqueueIngestionWork({
      orgId: input.orgId,
      kbId: kb.id,
      connector: "youtube",
      externalId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
      youtubeConfig: {
        connectionId: input.connectionId,
      },
      rootWorkItem: {
        workKey: videoId,
        kind: "resource",
      },
    });

    console.info(`[JOB:youtube-enqueue] complete jobId=${result.jobId} elapsedMs=${Date.now() - startedAt}`);
    return {
      ok: true,
      jobId: result.jobId,
      sourceId: result.sourceId,
      status: result.status,
    };
  } catch (error) {
    console.error(`[JOB:youtube-enqueue] failed elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** Resolves document -> YouTube source -> active connection and queues refresh. */
export async function refreshYouTubeDocument(input: {
  orgId: string;
  userId: string;
  documentId: string;
  kbSlug?: string;
}) {
  const doc = await db.knowledgeDocument.findFirst({
    where: {
      id: input.documentId,
      kb: { orgId: input.orgId },
      source: { connector: "youtube" },
    },
    select: {
      kbId: true,
      source: {
        select: {
          sourceUrl: true,
          youtube: {
            select: {
              connectionId: true,
              connection: { select: { id: true, status: true } },
            },
          },
        },
      },
    },
  });

  if (!doc || !doc.source || !doc.source.youtube) {
    throw new YouTubeError("NOT_FOUND", "YouTube document not found");
  }

  const connection = doc.source.youtube.connection;
  if (!connection || connection.status !== "active") {
    throw new YouTubeError("RECONNECT_REQUIRED", "Active YouTube connection not found for this document");
  }

  return queueYouTubeSync({
    orgId: input.orgId,
    userId: input.userId,
    kbId: doc.kbId,
    url: doc.source.sourceUrl,
    connectionId: doc.source.youtube.connectionId,
    refresh: true,
  });
}
