import { db } from "@/lib/db";
import { parseYouTubeVideoId, type YouTubeImportInput } from "@/lib/youtube";
import { publishIngestionMessage } from "@/lib/ingestion-queue";
import { youtubeClient } from "@/lib/youtube-server";
import { YouTubeError } from "../../shared/youtube/types";

type ImportContext = { orgId: string; userId: string; kbSlug: string };

async function knowledgeBase(orgId: string, kbSlug: string) {
  const kb = await db.knowledgeBase.findFirst({ where: { slug: kbSlug, orgId }, select: { id: true } });
  if (!kb) throw new YouTubeError("NOT_FOUND", "Knowledge base not found");
  return kb;
}

async function ownedConnection(orgId: string, userId: string, connectionId: string) {
  const connection = await db.youTubeConnection.findFirst({ where: { id: connectionId, orgId, userId, status: "active" }, select: { id: true } });
  if (!connection) throw new YouTubeError("RECONNECT_REQUIRED", "Connect your YouTube channel before importing");
  return connection;
}

/** Returns only safe connection metadata and this trainer's import jobs. */
export async function listYouTubeImports(orgId: string, userId: string, kbSlug: string) {
  const kb = await knowledgeBase(orgId, kbSlug);
  const [connections, jobs] = await Promise.all([
    db.youTubeConnection.findMany({ where: { orgId, userId, status: { not: "disconnected" } }, orderBy: { createdAt: "desc" }, select: { id: true, channelId: true, channelTitle: true, status: true } }),
    db.ingestionJob.findMany({
      where: { source: { orgId, kbId: kb.id, connector: "youtube", youtube: { connection: { userId, orgId } } } },
      orderBy: { createdAt: "desc" }, take: 20,
      select: {
        id: true, status: true, stage: true, error: true,
        source: { select: { externalId: true, youtube: { select: { connectionId: true } } } },
        workItems: { where: { kind: "segment" }, select: { status: true } },
      },
    }),
  ]);
  return {
    configured: ["YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET", "YOUTUBE_OAUTH_REDIRECT_URI", "YOUTUBE_TOKEN_ENCRYPTION_KEY"].every((name) => Boolean(process.env[name]?.trim())),
    connections, jobs: jobs.map(({ source, workItems, ...job }) => ({
      ...job,
      videoId: source.externalId,
      connectionId: source.youtube?.connectionId ?? null,
      segmentsTotal: workItems.length,
      segmentsSucceeded: workItems.filter((item) => item.status === "succeeded").length,
      segmentsFailed: workItems.filter((item) => item.status === "failed").length,
    })),
  };
}

/** Preview uses owner credentials on the server; the worker independently rechecks ownership. */
export async function previewYouTubeImport(input: ImportContext & YouTubeImportInput) {
  const kb = await knowledgeBase(input.orgId, input.kbSlug);
  await ownedConnection(input.orgId, input.userId, input.connectionId);
  const videoId = parseYouTubeVideoId(input.url);
  if (!videoId) throw new YouTubeError("INVALID_URL", "Invalid YouTube video URL");
  const video = await youtubeClient().inspectOwnedVideo(input, videoId);
  const existing = await db.knowledgeDocument.findFirst({ where: {
    kbId: kb.id, externalId: videoId, status: "indexed", source: { connector: "youtube", youtube: { connectionId: input.connectionId } },
  }, select: { id: true } });
  return { ...video, alreadyIndexed: Boolean(existing) };
}

/** Persists one video job; only identifiers are published, never tokens or captions. */
export async function queueYouTubeSync(input: ImportContext & YouTubeImportInput) {
  const startedAt = Date.now();
  console.info("[JOB:youtube-enqueue] start");
  try {
    const videoId = parseYouTubeVideoId(input.url);
    if (!videoId) throw new YouTubeError("INVALID_URL", "Invalid YouTube video URL");
    const kb = await knowledgeBase(input.orgId, input.kbSlug);
    await ownedConnection(input.orgId, input.userId, input.connectionId);
    const identityKey = `${kb.id}:youtube-owned:${videoId}`;
    const source = await db.knowledgeSource.upsert({
      where: { identityKey }, update: {},
      create: {
        orgId: input.orgId, kbId: kb.id, identityKey,
        connector: "youtube", externalId: videoId,
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        youtube: { create: { connectionId: input.connectionId } },
      },
      include: { youtube: { select: { connectionId: true } } },
    });
    if (source.youtube?.connectionId !== input.connectionId) throw new YouTubeError("CONNECTION_MISMATCH", "This video already belongs to another connection in this knowledge base");
    if (source.status === "expiring") throw new YouTubeError("CLEANUP_BUSY", "Stored transcript cleanup is in progress. Please retry shortly.", true);
    const activeKey = `${source.id}:${videoId}`;
    let job = await db.ingestionJob.findUnique({ where: { activeKey }, select: { id: true, status: true } });
    if (!job && !input.refresh) {
      const indexed = await db.knowledgeDocument.findFirst({ where: { sourceId: source.id, externalId: videoId, status: "indexed" }, select: { id: true } });
      if (indexed) return { alreadyIndexed: true, documentId: indexed.id };
    }
    if (!job) {
      try {
        job = await db.$transaction(async (tx) => {
          const current = await tx.$queryRawUnsafe<{ status: string }[]>(
            `SELECT status FROM "KnowledgeSource" WHERE id = $1 FOR UPDATE`, source.id);
          if (!current[0] || current[0].status === "expiring") throw new YouTubeError("CLEANUP_BUSY", "Stored transcript cleanup is in progress. Please retry shortly.", true);
          const connection = await tx.youTubeConnection.findFirst({ where: { id: input.connectionId, orgId: input.orgId, userId: input.userId, status: "active" } });
          if (!connection) throw new YouTubeError("RECONNECT_REQUIRED", "Reconnect your YouTube channel");
          return tx.ingestionJob.create({ data: {
            sourceId: source.id, activeKey, status: "queued", stage: "queued", itemsDiscovered: 1,
            workItems: { create: { workKey: videoId, kind: "resource", status: "queued" } },
          }, select: { id: true, status: true } });
        });
      } catch (error) {
        // The unique activeKey arbitrates concurrent requests; unrelated DB errors propagate.
        job = await db.ingestionJob.findUnique({ where: { activeKey }, select: { id: true, status: true } });
        if (!job) throw error;
      }
    }
    const workItem = await db.ingestionWorkItem.findUnique({ where: { jobId_workKey: { jobId: job.id, workKey: videoId } } });
    if (!workItem) throw new Error("YouTube job work item is missing");
    if (!workItem.enqueuedAt) {
      await publishIngestionMessage({ jobId: job.id, workItemId: workItem.id });
      await db.ingestionWorkItem.update({ where: { id: workItem.id }, data: { enqueuedAt: new Date() } });
    }
    console.info(`[JOB:youtube-enqueue] complete jobId=${job.id} elapsedMs=${Date.now() - startedAt}`);
    return { jobId: job.id, status: job.status };
  } catch (error) {
    console.error(`[JOB:youtube-enqueue] failed code=${error instanceof YouTubeError ? error.code : "QUEUE_ERROR"} elapsedMs=${Date.now() - startedAt}`);
    throw error;
  }
}

/** Disables access immediately; maintenance performs retryable token and content cleanup. */
export async function disconnectYouTube(orgId: string, userId: string, kbSlug: string, connectionId: string) {
  await knowledgeBase(orgId, kbSlug);
  await db.$transaction(async (tx) => {
    const result = await tx.youTubeConnection.updateMany({ where: { id: connectionId, orgId, userId, status: { not: "disconnected" } },
      data: { status: "disconnecting", refreshLeaseId: null, refreshLeaseExpiresAt: null } });
    if (!result.count) throw new YouTubeError("NOT_FOUND", "YouTube connection not found");
    // Leave running page leases intact so cleanup waits for in-flight writes to finish.
    await tx.ingestionJob.updateMany({ where: { status: { in: ["queued", "running"] }, source: { orgId, youtube: { connectionId } } },
      data: { status: "failed", stage: null, error: "YouTube connection disconnected", activeKey: null, finishedAt: new Date() } });
  });
  return { status: "disconnecting" };
}
