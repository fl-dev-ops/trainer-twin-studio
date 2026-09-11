import yaml from "js-yaml";
import type { Prisma } from "@/lib/generated/prisma/client";
import { deletePrefix, getObjectText, kbPrefix, presignedGetUrl, putObject } from "@/lib/s3";
import { db } from "@/lib/db";
import {
  ALL_DOCUMENT_EXTENSIONS,
  documentToMarkdown,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "@/lib/documents";
import { ingestDoc, knowledgeCollectionName, removeChunks, removeCollection, removeDoc } from "@/lib/knowledge";
import { personaCollectionName, personaCoverageLevel } from "@/lib/persona-voice";
import { MainCollectionService } from "@/lib/main-collection";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { enqueueIngestionWork } from "@/lib/ingestion-queue";

export type SpecType = "personas" | "agents" | "domains";

const SPEC_TYPES: SpecType[] = ["personas", "agents", "domains"];
const ENTITY_KEY: Record<SpecType, string> = {
  personas: "persona",
  agents: "agent",
  domains: "domain",
};

export function isSpecType(value: string): value is SpecType {
  return SPEC_TYPES.includes(value as SpecType);
}

export function validSlug(slug: string) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(slug);
}

type SpecRow = { id?: string; slug: string; name: string; version: number; data: unknown; orgId: string | null };
type SpecDelegate = {
  findUnique(args: { where: { slug: string } }): Promise<SpecRow | null>;
  findMany(args: { where?: { orgId: string }; orderBy: { slug: "asc" }; select: { slug: true } }): Promise<{ slug: string }[]>;
  create(args: { data: { slug: string; name: string; version: number; data: unknown; orgId: string; domainSlug?: string } }): Promise<{ version: number }>;
  update(args: { where: { slug: string }; data: { name: string; version: number; data: unknown; orgId?: string; domainSlug?: string } }): Promise<unknown>;
  delete(args: { where: { slug: string } }): Promise<unknown>;
};

function modelFor(type: SpecType): SpecDelegate {
  const model = type === "personas" ? db.persona : type === "agents" ? db.agent : db.domain;
  return model as unknown as SpecDelegate;
}

export async function listSpecs(type: SpecType, orgId: string): Promise<string[]> {
  const rows = await modelFor(type).findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true } });
  return rows.map((r) => r.slug);
}

export async function listSpecSummaries(type: "personas" | "agents", orgId: string) {
  if (type === "personas") {
    return db.persona.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true } });
  }

  const [agents, drafts] = await Promise.all([
    db.agent.findMany({
      where: { orgId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, version: true, visibility: true, data: true, order: true },
    }),
    db.specDraft.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
      select: { slug: true, name: true, status: true, revision: true, agentData: true },
    }),
  ]);
  const published = new Set(agents.map(({ slug }) => slug));
  const draftsBySlug = new Map(drafts.map((draft) => [draft.slug, draft]));
  return [
    ...agents.map((agent) => {
      const data = agent.data as { objective?: unknown } | null;
      const objective = typeof data?.objective === "string" ? data.objective : undefined;
      return {
        slug: agent.slug,
        name: agent.name,
        version: agent.version,
        visibility: agent.visibility,
        objective,
        status: "published" as const,
        draftRevision: draftsBySlug.get(agent.slug)?.status === "draft"
          ? draftsBySlug.get(agent.slug)?.revision
          : undefined,
      };
    }),
    ...drafts.filter(({ slug }) => !published.has(slug)).map((draft) => {
      const agent = draft.agentData as { objective?: unknown } | null;
      const objective = typeof agent?.objective === "string" ? agent.objective : undefined;
      return {
        slug: draft.slug,
        name: draft.name,
        version: draft.revision,
        objective,
        status: "draft" as const,
      };
    }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Specs complete enough for the Python interview runtime; editor drafts stay hidden from /talk. */
export async function listRunnableSpecs(type: "personas" | "agents", orgId: string): Promise<string[]> {
  const rows = type === "personas"
    ? await db.persona.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, data: true } })
    : await db.agent.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, data: true, personaId: true } });
  return rows.filter((row) => {
    const { data } = row;
    if (!isRecord(data)) return false;
    return type === "personas"
      ? isRecord(data.style) && isRecord(data.decision_preferences)
      : "personaId" in row && Boolean(row.personaId) && typeof data.objective === "string" && typeof data.opening === "string" && isRecord(data.config);
  }).map(({ slug }) => slug);
}

export async function listAgentPersonas(orgId: string, slugs: string[]) {
  const agents = await db.agent.findMany({
    where: { orgId, slug: { in: slugs } },
    select: { slug: true, persona: { select: { slug: true } } },
  });
  return Object.fromEntries(agents.map((agent) => [agent.slug, agent.persona.slug]));
}

export async function readSpec(type: SpecType, slug: string, orgId: string) {
  if (!validSlug(slug)) throw new Error(`Invalid id: ${slug}`);
  const row: SpecRow | null = type === "personas"
    ? await db.persona.findUnique({ where: { orgId_slug: { orgId, slug } } })
    : await modelFor(type).findUnique({ where: { slug } });
  if (!row || row.orgId !== orgId) return null;
  const doc = { schema_version: 1, kind: ENTITY_KEY[type], [ENTITY_KEY[type]]: row.data };
  return { text: yaml.dump(doc, { lineWidth: -1 }), doc: row.data as Record<string, unknown>, version: row.version };
}

export type SaveResult = {
  created: boolean;
  versionBumped: boolean;
  version?: number;
};

/**
 * Saves a spec (YAML text). On a changed update, snapshots the previous version
 * into SpecVersion and bumps the entity's version.
 */
export async function saveSpec(type: SpecType, slug: string, text: string, orgId: string): Promise<SaveResult> {
  if (!validSlug(slug)) throw new Error(`Invalid id: ${slug}`);
  const parsed = yaml.load(text.replace(/^```(?:ya?ml)?\s*\n?/i, "").replace(/\n?```\s*$/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid YAML document");
  }
  const entity = (parsed as Record<string, unknown>)[ENTITY_KEY[type]];
  if (!entity || typeof entity !== "object") {
    throw new Error(`Missing "${ENTITY_KEY[type]}:" section in YAML`);
  }
  const data = entity as Prisma.InputJsonValue & Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name : slug;
  let domainSlug: string | undefined;
  if (type === "agents") {
    domainSlug = typeof data.domain === "string" ? data.domain : undefined;
    if (!domainSlug || !validSlug(domainSlug)) {
      throw new Error('Agent requires a valid "domain" slug');
    }
    if (!(await db.domain.findUnique({ where: { slug: domainSlug }, select: { id: true } }))) {
      throw new Error(`Domain "${domainSlug}" does not exist`);
    }
    if (typeof data.voiceId === "string" && data.voiceId) {
      const voice = await db.voice.findFirst({
        where: {
          id: data.voiceId,
          status: "ready",
          OR: [{ orgId }, { orgId: null }],
        },
        select: { id: true },
      });
      if (!voice) throw new Error(`Voice "${data.voiceId}" is not available`);
    }
    if (typeof data.knowledgeBase === "string" && data.knowledgeBase) {
      const knowledge = await db.knowledgeBase.findFirst({
        where: { slug: data.knowledgeBase, orgId },
        select: { id: true },
      });
      if (!knowledge) throw new Error(`Knowledge base "${data.knowledgeBase}" is not available`);
    }
  }
  const relation = domainSlug ? { domainSlug } : {};

  const existing: SpecRow | null = type === "personas"
    ? await db.persona.findUnique({ where: { orgId_slug: { orgId, slug } } })
    : await modelFor(type).findUnique({ where: { slug } });
  if (!existing) {
    if (type === "agents") throw new Error("Create agents through Agent Studio so a persona is assigned");
    const created = type === "personas"
      ? await db.persona.create({ data: { slug, name, version: 1, data, orgId } })
      : await modelFor(type).create({ data: { slug, name, version: 1, data, orgId, ...relation } });
    return { created: true, versionBumped: false, version: created.version };
  }

  if (existing.orgId !== orgId) throw new Error("Not found");
  if (JSON.stringify(existing.data) === JSON.stringify(data)) {
    return { created: false, versionBumped: false, version: existing.version };
  }

  const nextVersion = existing.version + 1;
  await db.$transaction(async (tx) => {
    await tx.specVersion.create({
      data: { entityType: type, entitySlug: slug, version: existing.version, data: existing.data as Prisma.InputJsonValue, orgId },
    });
    if (type === "personas") {
      await tx.persona.update({ where: { orgId_slug: { orgId, slug } }, data: { name, version: nextVersion, data } });
    } else {
      const model = (type === "agents" ? tx.agent : tx.domain) as unknown as SpecDelegate;
      await model.update({ where: { slug }, data: { name, version: nextVersion, data, ...relation } });
    }
  });
  return { created: false, versionBumped: true, version: nextVersion };
}

export async function deleteSpec(type: SpecType, slug: string, orgId: string) {
  if (!validSlug(slug)) throw new Error(`Invalid id: ${slug}`);
  const row: SpecRow | null = type === "personas"
    ? await db.persona.findUnique({ where: { orgId_slug: { orgId, slug } } })
    : await modelFor(type).findUnique({ where: { slug } });
  if (!row || row.orgId !== orgId) throw new Error("Not found");
  await db.specVersion.deleteMany({ where: { entityType: type, entitySlug: slug, orgId } });
  if (type === "personas") {
    const personaId = row.id;
    if (!personaId) throw new Error("Persona identity missing");
    const sources = await db.personaSource.findMany({
      where: { personaId, orgId },
      select: { id: true, s3Key: true },
    });
    await Promise.all([
      ...sources.map((source) => deletePrefix(source.s3Key)),
      ...sources.map((source) => removeChunks(personaCollectionName(personaId), source.id)),
      MainCollectionService.removePersona(orgId, personaId),
    ]);
    await db.persona.delete({ where: { orgId_slug: { orgId, slug } } });
  } else {
    await modelFor(type).delete({ where: { slug } });
  }
}

export async function listVersions(type: SpecType, slug: string, orgId: string) {
  const rows = await db.specVersion.findMany({
    where: { entityType: type, entitySlug: slug, orgId },
    orderBy: { version: "desc" },
    select: { version: true, createdAt: true },
  });
  return rows.map((r) => ({
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    label: `v${r.version} — ${r.createdAt.toISOString().replace("T", " ").slice(0, 19)}`,
  }));
}

export async function readVersion(type: SpecType, slug: string, version: number, orgId: string) {
  const row = await db.specVersion.findUnique({
    where: { orgId_entityType_entitySlug_version: { orgId, entityType: type, entitySlug: slug, version } },
  });
  if (!row) return null;
  const doc = { schema_version: 1, kind: ENTITY_KEY[type], [ENTITY_KEY[type]]: row.data };
  return { text: yaml.dump(doc, { lineWidth: -1 }), data: row.data };
}

// ---- Knowledge bases (S3 + ChromaDB) ----

export const SUPPORTED_EXTENSIONS = SUPPORTED_DOCUMENT_EXTENSIONS;
export const ALL_KNOWLEDGE_EXTENSIONS = ALL_DOCUMENT_EXTENSIONS;

export async function listKnowledgeBases(orgId: string) {
  return db.knowledgeBase.findMany({
    where: { orgId },
    orderBy: { slug: "asc" },
    select: { slug: true, name: true },
  });
}

export async function listKnowledgeFiles(orgId: string, kbSlug: string) {
  const kb = await db.knowledgeBase.findFirst({ where: { slug: kbSlug, orgId }, select: { id: true } });
  if (!kb) return [];
  const docs = await db.knowledgeDocument.findMany({
    where: { kbId: kb.id },
    orderBy: { slug: "asc" },
    select: { id: true, slug: true, title: true, ext: true, size: true, status: true, error: true, indexedAt: true, createdAt: true },
  });
  return docs;
}

export async function readKnowledgeFile(orgId: string, kbSlug: string, fileSlug: string) {
  const kb = await db.knowledgeBase.findFirst({ where: { slug: kbSlug, orgId }, select: { id: true } });
  if (!kb) return null;
  const doc = await db.knowledgeDocument.findUnique({
    where: { kbId_slug: { kbId: kb.id, slug: fileSlug } },
  });
  return doc;
}

export async function createKnowledgeBase(orgId: string, slug: string) {
  if (!validSlug(slug)) throw new Error("Invalid knowledge base name");
  const existing = await db.knowledgeBase.findFirst({ where: { slug, orgId }, select: { id: true } });
  if (existing) return existing;
  return db.knowledgeBase.create({ data: { slug, name: slug.replace(/[-_]/g, " "), orgId } });
}

export async function deleteKnowledge(orgId: string, kbSlug: string, fileSlug?: string) {
  const kb = await db.knowledgeBase.findFirst({ where: { slug: kbSlug, orgId }, select: { id: true } });
  if (fileSlug === undefined) {
    if (!kb) return;
    await Promise.all([
      deletePrefix(kbPrefix(orgId, kb.id)),
      removeCollection(knowledgeCollectionName(kb.id), orgId),
    ]);
    await db.knowledgeBase.delete({ where: { id: kb.id } });
    return;
  }
  if (!kb) return;
  const doc = await db.knowledgeDocument.findUnique({
    where: { kbId_slug: { kbId: kb.id, slug: fileSlug } },
  });
  if (!doc) return;
  await Promise.all([
    deletePrefix(kbPrefix(orgId, kb.id, doc.id)),
    removeDoc(kb.id, doc.id, orgId),
  ]);
  await db.knowledgeDocument.delete({ where: { id: doc.id } });
}

export type UploadResult = {
  id: string;
  slug: string;
  markdownChars: number;
  jobId?: string;
  status?: string;
  ok?: boolean;
};

/** Converts anydoc-supported files to markdown, stores source + markdown in S3, records the doc. */
export async function uploadKnowledgeFile(orgId: string, kbSlug: string, file: File): Promise<UploadResult> {
  if (!validSlug(kbSlug)) throw new Error("Invalid knowledge base name");
  await createKnowledgeBase(orgId, kbSlug);
  const { ext, bytes, markdown } = await documentToMarkdown(file);

  const kb = await db.knowledgeBase.findFirstOrThrow({ where: { slug: kbSlug, orgId } });
  const baseSlug = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120);
  let slug = `${baseSlug}.${ext}`;
  let n = 1;
  while (await db.knowledgeDocument.findFirst({ where: { kbId: kb.id, slug }, select: { id: true } })) {
    slug = `${baseSlug}-${n++}.${ext}`;
  }

  const doc = await db.knowledgeDocument.create({
    data: {
      kbId: kb.id,
      slug,
      title: baseSlug.replace(/[-_]/g, " "),
      ext,
      size: file.size,
      s3SourceKey: "pending",
      s3MarkdownKey: "pending",
    },
  });

  const sourceKey = kbPrefix(orgId, kb.id, doc.id) + `/source-${slug}`;
  const markdownKey = kbPrefix(orgId, kb.id, doc.id) + "/content.md";
  await Promise.all([
    putObject(sourceKey, bytes, file.type || "application/octet-stream"),
    putObject(markdownKey, markdown, "text/markdown; charset=utf-8"),
  ]);
  await db.knowledgeDocument.update({
    where: { id: doc.id },
    data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey, status: "uploaded" },
  });

  await ChromaTenantService.createOrgDatabase(orgId);
  const queueResult = await enqueueIngestionWork({
    orgId,
    kbId: kb.id,
    connector: "upload",
    externalId: doc.id,
    sourceUrl: `upload://${slug}`,
    rootWorkItem: {
      workKey: doc.id,
      kind: "resource",
      payload: { docId: doc.id, title: doc.title, slug: doc.slug },
    },
  });

  await db.knowledgeDocument.update({
    where: { id: doc.id },
    data: { sourceId: queueResult.sourceId, status: "queued" },
  });

  return { id: doc.id, slug, markdownChars: markdown.length, jobId: queueResult.jobId, status: "queued" };
}

/** Presigned URL for the original file, for the in-browser preview. */
export async function getKnowledgePreviewUrl(orgId: string, kbSlug: string, fileSlug: string) {
  const doc = await readKnowledgeFile(orgId, kbSlug, fileSlug);
  if (!doc) return null;
  return presignedGetUrl(doc.s3SourceKey);
}

/** Indexes (or re-indexes) documents asynchronously through SQS. */
export async function digestKnowledge(orgId: string, kbSlug: string, fileSlug?: string) {
  const kb = await db.knowledgeBase.findFirst({
    where: { slug: kbSlug, orgId },
    include: { documents: true },
  });
  if (!kb) throw new Error("Knowledge base not found");
  const docs = (fileSlug ? kb.documents.filter((d) => d.slug === fileSlug) : kb.documents).filter(
    (d) => d.status !== "digesting",
  );
  if (docs.length === 0) throw new Error("No documents to index");

  await ChromaTenantService.createOrgDatabase(orgId);

  const queuedJobs = [];
  for (const d of docs) {
    if (!d.s3MarkdownKey || d.s3MarkdownKey === "pending") continue;
    const queueResult = await enqueueIngestionWork({
      orgId,
      kbId: kb.id,
      connector: "upload",
      externalId: d.id,
      sourceUrl: `upload://${d.slug}`,
      rootWorkItem: {
        workKey: d.id,
        kind: "resource",
        payload: { docId: d.id, title: d.title, slug: d.slug },
      },
    });

    await db.knowledgeDocument.update({
      where: { id: d.id },
      data: { sourceId: queueResult.sourceId, status: "queued", error: null },
    });

    queuedJobs.push({ id: d.id, jobId: queueResult.jobId });
  }

  return { ok: true, indexed: queuedJobs.length, queued: queuedJobs.length, jobs: queuedJobs };
}

/** Removes a document's embeddings from its ChromaDB collection. */
export async function removeEmbeddings(orgId: string, kbSlug: string, docIds: string[]) {
  const kb = await db.knowledgeBase.findFirst({ where: { orgId, slug: kbSlug }, select: { id: true } });
  if (!kb) return;
  for (const docId of docIds) await removeDoc(kb.id, docId, orgId);
}
// ---- Learner context documents ----

export async function saveUpload(orgId: string, name: string, mimeType: string, content: Buffer) {
  if (!/^[a-z0-9][a-z0-9._-]*\.(md|txt|pdf)$/i.test(name)) {
    throw new Error("Only .md, .txt or .pdf uploads are supported");
  }
  return db.contextDocument.create({
    data: { orgId, name, mimeType, content: new Uint8Array(content), size: content.length },
    select: { id: true, name: true, size: true, createdAt: true },
  });
}

export async function listUploads(orgId: string) {
  return db.contextDocument.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, size: true, createdAt: true },
  });
}

export async function readUploadBytes(id: string, orgId: string) {
  return db.contextDocument.findFirst({ where: { id, orgId } });
}

// ---- Compiled config for the voice agent ----

export async function getAgentConfigForAgent(agentId: string, orgId: string, contextId?: string) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, orgId },
    include: { persona: true },
  });
  if (!agent) return null;
  const [domain, contextDoc] = await Promise.all([
    db.domain.findFirst({ where: { slug: agent.domainSlug, orgId } }),
    contextId ? readUploadBytes(contextId, orgId) : Promise.resolve(null),
  ]);
  const persona = agent.persona;
  if (!domain) return null;

  // An agent attachment narrows retrieval to exactly one collection. Legacy
  // agents keep their Domain's selected collections until explicitly configured.
  const attachedKnowledge = isRecord(agent.data) && typeof agent.data.knowledgeBase === "string"
    ? [agent.data.knowledgeBase]
    : [];
  const domainKnowledge = isRecord(domain.data) && Array.isArray(domain.data.knowledge_bases)
    ? domain.data.knowledge_bases.filter((value): value is string => typeof value === "string")
    : [];
  const configuredKnowledge = attachedKnowledge.length ? attachedKnowledge : domainKnowledge;
  const indexed = await db.knowledgeDocument.findMany({
    where: {
      status: "indexed",
      kb: {
        orgId,
        ...(configuredKnowledge.length ? { slug: { in: configuredKnowledge } } : {}),
      },
    },
    select: { kb: { select: { slug: true } } },
    distinct: ["kbId"],
  });
  const knowledgeBases = indexed.map((row) => row.kb.slug);
  const personaVoiceSources = await db.personaSource.findMany({
    where: { personaId: persona.id, orgId, status: { in: ["analyzed", "compiling"] } },
    select: { metadata: true },
  });
  const personaVoiceAvailable = personaVoiceSources.some((source) =>
    isRecord(source.metadata) && typeof source.metadata.voiceMoments === "number" && source.metadata.voiceMoments > 0,
  );
  const personaVoiceCoverage = personaCoverageLevel(personaVoiceSources);

  let context: { id: string; name: string; content: string } | null = null;
  if (contextDoc) {
    // The agent can run on another machine: send readable content, not a web-local path.
    const { markdown } = await documentToMarkdown(
      new File([new Uint8Array(contextDoc.content)], contextDoc.name, { type: contextDoc.mimeType }),
    );
    context = { id: contextDoc.id, name: contextDoc.name, content: markdown };
  }

  return {
    persona: { id: persona.id, slug: persona.slug, version: persona.version, data: persona.data },
    agent: { id: agent.id, slug: agent.slug, version: agent.version, data: agent.data },
    domain: { slug: domain.slug, version: domain.version, data: domain.data },
    knowledgeBases,
    personaVoiceAvailable,
    personaVoiceCoverage,
    context,
  };
}

/** Compatibility check used by Studio diagnostics; live agents load by session. */
export async function getAgentConfig(personaSlug: string, agentSlug: string, contextId?: string) {
  const agent = await db.agent.findUnique({
    where: { slug: agentSlug },
    select: { id: true, orgId: true, persona: { select: { slug: true } } },
  });
  if (!agent?.orgId || agent.persona.slug !== personaSlug) return null;
  return getAgentConfigForAgent(agent.id, agent.orgId, contextId);
}

// ---- Interview sessions ----

export async function listSessions(orgId: string) {
  return db.interviewSession.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

