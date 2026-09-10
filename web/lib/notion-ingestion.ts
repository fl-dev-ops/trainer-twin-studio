import { db } from "@/lib/db";
import { parseNotionPageId, type NotionImportInput } from "@/lib/notion";
import { enqueueIngestionWork } from "@/lib/ingestion-queue";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";

/** Lists the organization's Notion connections and recent jobs for one knowledge base. */
export async function listNotionImports(orgId: string, kbId: string) {
  const [connections, jobs] = await Promise.all([
    db.notionConnection.findMany({
      where: { orgId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, workspaceId: true, workspaceName: true, workspaceIcon: true, createdAt: true },
    }),
    db.ingestionJob.findMany({
      where: {
        source: {
          orgId,
          kbId,
          connector: { in: ["notion", "notion_public"] },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        stage: true,
        itemsDiscovered: true,
        itemsProcessed: true,
        error: true,
        createdAt: true,
        finishedAt: true,
        source: {
          select: {
            id: true,
            connector: true,
            externalId: true,
            sourceUrl: true,
            notion: { select: { connectionId: true, accessMode: true } },
          },
        },
      },
    }),
  ]);

  return {
    configured: Boolean(process.env.NOTION_OAUTH_CLIENT_ID && process.env.NOTION_OAUTH_CLIENT_SECRET),
    connections,
    jobs: jobs.map(({ source, ...job }) => ({
      ...job,
      sourceId: source.id,
      connector: source.connector,
      pageId: source.externalId,
      connectionId: source.notion?.connectionId ?? null,
      accessMode: source.notion?.accessMode ?? "owned",
    })),
  };
}

/** Creates a durable job/root-page record and publishes its identifier-only SQS message. */
export async function queueNotionSync(input: {
  orgId: string;
  userId: string;
  kbId?: string;
  kbSlug?: string;
} & NotionImportInput) {
  const isPublic = input.mode === "public";
  const rootPageId = parseNotionPageId(isPublic ? new URL(input.url).pathname : input.url);
  const sourceUrl = isPublic ? `https://www.notion.so/${rootPageId.replaceAll("-", "")}` : input.url;

  let kbId = input.kbId;
  if (!kbId && input.kbSlug) {
    const kb = await db.knowledgeBase.findFirst({ where: { slug: input.kbSlug, orgId: input.orgId } });
    if (kb) kbId = kb.id;
  }
  if (!kbId) {
    const defaultKb = await getOrCreateOrgKnowledgeBase(input.orgId);
    kbId = defaultKb.id;
  }

  let connectionId: string | undefined = undefined;
  if (!isPublic) {
    if (!input.connectionId) throw new Error("connectionId is required for owned Notion imports");
    const connection = await db.notionConnection.findFirst({
      where: { id: input.connectionId, orgId: input.orgId },
    });
    if (!connection) throw new Error("Notion connection not found");
    connectionId = connection.id;
  }

  const identityKey = isPublic
    ? `${kbId}:notion-public:${rootPageId}`
    : `${kbId}:notion-owned:${connectionId}:${rootPageId}`;

  const result = await enqueueIngestionWork({
    orgId: input.orgId,
    kbId,
    connector: isPublic ? "notion_public" : "notion",
    externalId: rootPageId,
    sourceUrl,
    identityKey,
    notionConfig: {
      connectionId: connectionId ?? null,
      accessMode: isPublic ? "public" : "owned",
    },
    rootWorkItem: {
      workKey: rootPageId,
      kind: "resource",
    },
  });

  return {
    ok: true,
    jobId: result.jobId,
    sourceId: result.sourceId,
    workItemId: result.workItemId,
    status: result.status,
  };
}
