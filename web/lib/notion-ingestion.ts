import { db } from "@/lib/db";
import { parseNotionPageId, type NotionImportInput } from "@/lib/notion";
import { publishIngestionMessage } from "@/lib/ingestion-queue";

/** Lists the signed-in trainer's Notion connections and recent jobs for one knowledge base. */
export async function listNotionImports(orgId: string, userId: string, kbSlug: string) {
  const kb = await db.knowledgeBase.findFirst({
    where: { slug: kbSlug, orgId },
    select: { id: true },
  });
  if (!kb) throw new Error("Knowledge base not found");

  const [connections, jobs] = await Promise.all([
    db.notionConnection.findMany({
      where: { orgId, userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, workspaceId: true, workspaceName: true },
    }),
    db.ingestionJob.findMany({
      where: {
        source: {
          orgId,
          kbId: kb.id,
          OR: [
            { connector: "notion", notion: { connection: { userId } } },
            { connector: "notion_public" },
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        itemsDiscovered: true,
        itemsProcessed: true,
        error: true,
        createdAt: true,
        finishedAt: true,
        source: { select: { notion: { select: { connectionId: true } } } },
      },
    }),
  ]);
  return {
    connections,
    jobs: jobs.map(({ source, ...job }) => ({
      ...job,
      connectionId: source.notion?.connectionId ?? null,
    })),
  };
}

/** Creates a durable job/root-page record and publishes its identifier-only SQS message. */
export async function queueNotionSync(input: {
  orgId: string;
  userId: string;
  kbSlug: string;
} & NotionImportInput) {
  const isPublic = input.mode === "public";
  const rootPageId = parseNotionPageId(isPublic ? new URL(input.url).pathname : input.url);
  const sourceUrl = isPublic ? `https://www.notion.so/${rootPageId.replaceAll("-", "")}` : input.url;
  const [kb, connection] = await Promise.all([
    db.knowledgeBase.findFirst({ where: { slug: input.kbSlug, orgId: input.orgId } }),
    input.mode === "public" ? null : db.notionConnection.findFirst({
      where: { id: input.connectionId, orgId: input.orgId, userId: input.userId },
    }),
  ]);
  if (!kb) throw new Error("Knowledge base not found");
  if (!isPublic && !connection) throw new Error("Notion connection not found");

  const identityKey = isPublic
    ? `${kb.id}:notion-public:${rootPageId}`
    : `${kb.id}:notion-owned:${connection!.id}:${rootPageId}`;
  const source = await db.knowledgeSource.upsert({
    where: { identityKey },
    update: { sourceUrl },
    create: {
      orgId: input.orgId,
      kbId: kb.id,
      identityKey,
      connector: isPublic ? "notion_public" : "notion",
      externalId: rootPageId,
      sourceUrl,
      notion: { create: { accessMode: isPublic ? "public" : "owned", connectionId: connection?.id } },
    },
  });

  let existing = false;
  let created: {
    job: { id: string };
    workItem: {
      id: string;
      workKey: string;
      enqueuedAt: Date | null;
    };
  };
  try {
    created = await db.$transaction(async (tx) => {
      const job = await tx.ingestionJob.create({
        data: { sourceId: source.id, activeKey: source.id, itemsDiscovered: 1 },
        select: { id: true },
      });
      const workItem = await tx.ingestionWorkItem.create({
        data: { jobId: job.id, workKey: rootPageId, kind: "resource" },
        select: { id: true, workKey: true, enqueuedAt: true },
      });
      return { job, workItem };
    });
  } catch (error) {
    const isActiveJobConflict =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002";
    if (!isActiveJobConflict) throw error;

    const job = await db.ingestionJob.findUnique({
      where: { activeKey: source.id },
      select: { id: true },
    });
    if (!job) throw error;
    const workItem = await db.ingestionWorkItem.findUniqueOrThrow({
      where: { jobId_workKey: { jobId: job.id, workKey: rootPageId } },
      select: { id: true, workKey: true, enqueuedAt: true },
    });
    if (workItem.enqueuedAt) {
      const persistedJob = await db.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
      return { job: persistedJob, workItem, enqueued: true, existing: true };
    }
    existing = true;
    created = { job, workItem };
  }

  const message = { jobId: created.job.id, workItemId: created.workItem.id };
  const enqueueStartedAt = Date.now();
  console.info(
    `[JOB:notion-sync] enqueue-start jobId=${message.jobId} sourceId=${source.id} workItemId=${message.workItemId}`,
  );
  try {
    await publishIngestionMessage(message);
    await db.ingestionWorkItem.update({
      where: { id: created.workItem.id },
      data: { enqueuedAt: new Date() },
    });
    console.info(
      `[JOB:notion-sync] enqueue-complete jobId=${message.jobId} sourceId=${source.id} workItemId=${message.workItemId} elapsedMs=${Date.now() - enqueueStartedAt}`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Could not enqueue Notion sync";
    await db.$transaction([
      db.ingestionJob.update({
        where: { id: created.job.id },
        data: { status: "failed", activeKey: null, error: errorMessage, finishedAt: new Date() },
      }),
      db.ingestionWorkItem.update({
        where: { id: created.workItem.id },
        data: { status: "failed", error: errorMessage },
      }),
    ]);
    console.error(
      `[JOB:notion-sync] enqueue-failed jobId=${message.jobId} sourceId=${source.id} workItemId=${message.workItemId} elapsedMs=${Date.now() - enqueueStartedAt} error=${errorMessage}`,
    );
    throw error;
  }

  const job = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.job.id } });
  const workItem = await db.ingestionWorkItem.findUniqueOrThrow({ where: { id: created.workItem.id } });
  return { job, workItem, enqueued: true, existing };
}
