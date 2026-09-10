import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { db } from "@/lib/db";
import { ingestionMessageSchema, type IngestionMessage } from "@/lib/ingestion-message";

function queueUrl(): string | undefined {
  return process.env.INGESTION_QUEUE_URL?.trim();
}

function awsRegion(): string {
  return process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || "us-east-1";
}

let sqsClient: SQSClient | undefined;

function getSqsClient(): SQSClient {
  sqsClient ??= new SQSClient({ region: awsRegion() });
  return sqsClient;
}

/**
 * Publishes only durable database identifiers to SQS.
 * Zero tokens, URLs, Markdown, or org IDs enter the message body.
 */
export async function publishIngestionMessage(message: IngestionMessage): Promise<boolean> {
  const payload = ingestionMessageSchema.parse(message);
  const targetQueue = queueUrl();
  if (!targetQueue) {
    console.warn(`[IngestionQueue] INGESTION_QUEUE_URL not configured. Skipping SQS message dispatch for jobId=${payload.jobId} workItemId=${payload.workItemId}`);
    return false;
  }

  await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: targetQueue,
      MessageBody: JSON.stringify(payload),
    })
  );
  return true;
}

export type EnqueueIngestionParams = {
  orgId: string;
  kbId: string;
  connector: "upload" | "notion" | "notion_public" | "youtube";
  externalId: string;
  sourceUrl: string;
  identityKey?: string;
  notionConfig?: {
    connectionId?: string | null;
    accessMode: "owned" | "public";
  };
  youtubeConfig?: {
    connectionId: string;
    captionId?: string | null;
  };
  rootWorkItem?: {
    workKey?: string;
    kind?: string;
    payload?: any;
  };
};

/**
 * Single server helper responsible for:
 * 1. Creating/finding the KnowledgeSource
 * 2. Coalescing an existing active job
 * 3. Creating the root work item
 * 4. Committing those rows in DB
 * 5. Sending the identifier-only SQS message
 * 6. Setting enqueuedAt after successful publication
 */
export async function enqueueIngestionWork(params: EnqueueIngestionParams): Promise<{
  sourceId: string;
  jobId: string;
  workItemId: string;
  status: string;
}> {
  const { orgId, kbId, connector, externalId, sourceUrl, notionConfig, youtubeConfig, rootWorkItem } = params;
  const identityKey = params.identityKey ?? `${orgId}:${connector}:${externalId}`;

  // 1 & 2 & 3 & 4. Transactionally upsert source, coalesce/create job and root work item
  const result = await db.$transaction(async (tx) => {
    // Upsert source
    let source = await tx.knowledgeSource.findUnique({
      where: { identityKey },
    });

    if (!source) {
      source = await tx.knowledgeSource.create({
        data: {
          orgId,
          kbId,
          connector,
          externalId,
          identityKey,
          sourceUrl,
          status: "syncing",
        },
      });

      if (connector === "notion" || connector === "notion_public") {
        await tx.notionSourceConfig.create({
          data: {
            sourceId: source.id,
            connectionId: notionConfig?.connectionId ?? null,
            accessMode: notionConfig?.accessMode ?? (connector === "notion_public" ? "public" : "owned"),
          },
        });
      } else if (connector === "youtube" && youtubeConfig) {
        await tx.youTubeSourceConfig.create({
          data: {
            sourceId: source.id,
            connectionId: youtubeConfig.connectionId,
            captionId: youtubeConfig.captionId ?? null,
          },
        });
      }
    } else {
      source = await tx.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: "syncing",
          error: null,
        },
      });
    }

    // Coalesce existing active job
    const activeKey = `${source.id}:active`;
    const existingJob = await tx.ingestionJob.findFirst({
      where: {
        sourceId: source.id,
        status: { in: ["queued", "running"] },
      },
      include: {
        workItems: {
          where: { status: { in: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (existingJob) {
      const activeWorkItem = existingJob.workItems[0];
      if (activeWorkItem) {
        return {
          sourceId: source.id,
          jobId: existingJob.id,
          workItemId: activeWorkItem.id,
          status: existingJob.status,
          alreadyActive: true,
        };
      }
    }

    // Create a new job
    const job = await tx.ingestionJob.create({
      data: {
        sourceId: source.id,
        activeKey,
        status: "queued",
      },
    });

    // Create the root work item
    const workKey = rootWorkItem?.workKey ?? externalId ?? "root";
    const kind = rootWorkItem?.kind ?? "resource";
    const payload = rootWorkItem?.payload ?? null;

    const workItem = await tx.ingestionWorkItem.create({
      data: {
        jobId: job.id,
        workKey,
        kind,
        payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
        status: "queued",
      },
    });

    return {
      sourceId: source.id,
      jobId: job.id,
      workItemId: workItem.id,
      status: job.status,
      alreadyActive: false,
    };
  });

  if (result.alreadyActive) {
    return result;
  }

  // 5. Send identifier-only SQS message
  try {
    const published = await publishIngestionMessage({
      jobId: result.jobId,
      workItemId: result.workItemId,
    });

    // 6. Set enqueuedAt upon successful dispatch
    if (published) {
      await db.ingestionWorkItem.update({
        where: { id: result.workItemId },
        data: { enqueuedAt: new Date() },
      });
    }
  } catch (error) {
    console.error(`[IngestionQueue] Failed to send SQS message for job ${result.jobId}:`, error);
    // Work item remains status='queued' and enqueuedAt=null for outbox recovery
  }

  return result;
}

/**
 * Outbox pump: recovers committed work items where status = queued AND enqueuedAt IS NULL.
 */
export async function pumpIngestionOutbox(limit = 50): Promise<number> {
  const pending = await db.ingestionWorkItem.findMany({
    where: {
      status: "queued",
      enqueuedAt: null,
    },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  let sentCount = 0;
  for (const item of pending) {
    try {
      const published = await publishIngestionMessage({
        jobId: item.jobId,
        workItemId: item.id,
      });
      if (published) {
        await db.ingestionWorkItem.update({
          where: { id: item.id },
          data: { enqueuedAt: new Date() },
        });
        sentCount++;
      }
    } catch (error) {
      console.error(`[IngestionQueue] Outbox pump failed for workItem ${item.id}:`, error);
    }
  }
  return sentCount;
}
