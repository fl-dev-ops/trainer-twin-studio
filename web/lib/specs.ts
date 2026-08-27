import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { Prisma } from "@/lib/generated/prisma/client";
import { deletePrefix, getObjectText, kbPrefix, presignedGetUrl, putObject } from "@/lib/s3";
import { db } from "@/lib/db";
import {
  ALL_DOCUMENT_EXTENSIONS,
  documentToMarkdown,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "@/lib/documents";
import { ingestDoc, removeDoc } from "@/lib/knowledge";

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

type SpecDelegate = {
  findUnique(args: { where: { slug: string } }): Promise<{ slug: string; name: string; version: number; data: unknown; orgId: string | null } | null>;
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
    db.agent.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true, domainSlug: true, visibility: true } }),
    // ponytail: drafts are only written by the still-single-tenant copilot; scope them when it goes multi-tenant
    db.specDraft.findMany({ orderBy: { slug: "asc" }, select: { slug: true, name: true, revision: true, domainData: true } }),
  ]);
  const published = new Set(agents.map(({ slug }) => slug));
  return [
    ...agents.map((agent) => ({ ...agent, status: "published" as const })),
    ...drafts.filter(({ slug }) => !published.has(slug)).map((draft) => ({
      slug: draft.slug,
      name: draft.name,
      version: draft.revision,
      domainSlug: isRecord(draft.domainData) && typeof draft.domainData.id === "string" ? draft.domainData.id : undefined,
      status: "draft" as const,
    })),
  ].sort((a, b) => a.slug.localeCompare(b.slug));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Specs complete enough for the Python interview runtime; editor drafts stay hidden from /talk. */
export async function listRunnableSpecs(type: "personas" | "agents", orgId: string): Promise<string[]> {
  const rows = type === "personas"
    ? await db.persona.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, data: true } })
    : await db.agent.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, data: true } });
  return rows.filter(({ data }) => {
    if (!isRecord(data)) return false;
    return type === "personas"
      ? isRecord(data.style) && isRecord(data.decision_preferences)
      : typeof data.objective === "string" && typeof data.opening === "string" && isRecord(data.config);
  }).map(({ slug }) => slug);
}

export async function readSpec(type: SpecType, slug: string, orgId: string) {
  if (!validSlug(slug)) throw new Error(`Invalid id: ${slug}`);
  const row = await modelFor(type).findUnique({ where: { slug } });
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
  const parsed = yaml.load(text);
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

  const existing = await modelFor(type).findUnique({ where: { slug } });
  if (!existing) {
    const created = await modelFor(type).create({ data: { slug, name, version: 1, data, orgId, ...relation } });
    return { created: true, versionBumped: false, version: created.version };
  }

  if (!existing || existing.orgId !== orgId) throw new Error("Not found");
  if (JSON.stringify(existing.data) === JSON.stringify(data)) {
    return { created: false, versionBumped: false, version: existing.version };
  }

  const nextVersion = existing.version + 1;
  await db.$transaction(async (tx) => {
    await tx.specVersion.create({
      data: { entityType: type, entitySlug: slug, version: existing.version, data: existing.data as Prisma.InputJsonValue },
    });
    const model = (type === "personas" ? tx.persona : type === "agents" ? tx.agent : tx.domain) as unknown as SpecDelegate;
    await model.update({ where: { slug }, data: { name, version: nextVersion, data, ...relation } });
  });
  return { created: false, versionBumped: true, version: nextVersion };
}

export async function deleteSpec(type: SpecType, slug: string, orgId: string) {
  if (!validSlug(slug)) throw new Error(`Invalid id: ${slug}`);
  const row = await modelFor(type).findUnique({ where: { slug } });
  if (!row || row.orgId !== orgId) throw new Error("Not found");
  await db.specVersion.deleteMany({ where: { entityType: type, entitySlug: slug } });
  await modelFor(type).delete({ where: { slug } });
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
    where: { entityType_entitySlug_version: { entityType: type, entitySlug: slug, version } },
  });
  if (!row || row.orgId !== orgId) return null;
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
    await deletePrefix(kbPrefix(kbSlug));
    await db.knowledgeBase.delete({ where: { id: kb.id } });
    return;
  }
  if (!kb) return;
  if (!kb) return;
  const doc = await db.knowledgeDocument.findUnique({
    where: { kbId_slug: { kbId: kb.id, slug: fileSlug } },
  });
  if (!doc) return;
  await deletePrefix(kbPrefix(kbSlug, doc.id));
  await db.knowledgeDocument.delete({ where: { id: doc.id } });
}

export type UploadResult = {
  id: string;
  slug: string;
  markdownChars: number;
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

  const sourceKey = kbPrefix(kbSlug, doc.id) + `/source-${slug}`;
  const markdownKey = kbPrefix(kbSlug, doc.id) + "/content.md";
  await Promise.all([
    putObject(sourceKey, bytes, file.type || "application/octet-stream"),
    putObject(markdownKey, markdown, "text/markdown; charset=utf-8"),
  ]);
  await db.knowledgeDocument.update({
    where: { id: doc.id },
    data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey },
  });
  return { id: doc.id, slug, markdownChars: markdown.length };
}

/** Presigned URL for the original file, for the in-browser preview. */
export async function getKnowledgePreviewUrl(orgId: string, kbSlug: string, fileSlug: string) {
  const doc = await readKnowledgeFile(orgId, kbSlug, fileSlug);
  if (!doc) return null;
  return presignedGetUrl(doc.s3SourceKey);
}

/** Indexes (or re-indexes) documents into ChromaDB. */
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

  await db.knowledgeDocument.updateMany({
    where: { id: { in: docs.map((d) => d.id) } },
    data: { status: "digesting", error: null },
  });

  try {
    const results: { id: string; chunks: number }[] = [];
    for (const d of docs) {
      if (!d.s3MarkdownKey || d.s3MarkdownKey === "pending") continue;
      const markdown = await getObjectText(d.s3MarkdownKey);
      const chunks = await ingestDoc(kbSlug, d.id, d.slug, markdown);
      results.push({ id: d.id, chunks });
    }
    const byId = new Map(results.map((r) => [r.id, r.chunks]));
    await db.$transaction(
      docs.map((d) =>
        db.knowledgeDocument.update({
          where: { id: d.id },
          data: {
            status: byId.has(d.id) ? "indexed" : "failed",
            error: byId.has(d.id) ? null : "No content indexed",
            indexedAt: byId.has(d.id) ? new Date() : null,
          },
        }),
      ),
    );
    return { indexed: results.length };
  } catch (error) {
    await db.knowledgeDocument.updateMany({
      where: { id: { in: docs.map((d) => d.id) } },
      data: { status: "failed", error: error instanceof Error ? error.message : "Digestion failed" },
    });
    throw error;
  }
}

/** Removes a document's embeddings from its ChromaDB collection. */
export async function removeEmbeddings(kbSlug: string, docIds: string[]) {
  for (const docId of docIds) {
    await removeDoc(kbSlug, docId);
  }
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

export async function readUploadBytes(id: string) {
  return db.contextDocument.findUnique({ where: { id } });
}

// ---- Compiled config for the voice agent ----

export async function getAgentConfig(personaSlug: string, agentSlug: string, contextId?: string) {
  const [persona, agent, domain] = await Promise.all([
    db.persona.findUnique({ where: { slug: personaSlug } }),
    db.agent.findUnique({ where: { slug: agentSlug } }),
    (async () => {
      const a = await db.agent.findUnique({ where: { slug: agentSlug }, select: { domainSlug: true } });
      return a ? db.domain.findUnique({ where: { slug: a.domainSlug } }) : null;
    })(),
  ]);
  if (!persona || !agent || !domain) return null;
  // The persona pins the organization; everything else must belong to it.
  const orgId = persona.orgId;
  if (!orgId) return null;
  if (agent.orgId !== orgId || domain.orgId !== orgId) return null;

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

  let context: { name: string; content: string } | null = null;
  if (contextId) {
    const doc = await readUploadBytes(contextId);
    if (doc) {
      if (/\.pdf$/i.test(doc.name)) {
        // materialize for the agent; it extracts text with the POC loader
        const tmp = path.join(tmpdir(), `tt-context-${doc.id}${path.extname(doc.name)}`);
        await fs.writeFile(tmp, Buffer.from(doc.content));
        context = { name: doc.name, content: tmp };
      } else {
        context = { name: doc.name, content: Buffer.from(doc.content).toString("utf-8") };
      }
    }
  }

  return {
    persona: { slug: persona.slug, version: persona.version, data: persona.data },
    agent: { slug: agent.slug, version: agent.version, data: agent.data },
    domain: { slug: domain.slug, version: domain.version, data: domain.data },
    knowledgeBases,
    context,
  };
}

// ---- Interview sessions ----

export async function listSessions(orgId: string) {
  return db.interviewSession.findMany({ where: { orgId }, orderBy: { startedAt: "desc" }, take: 50 });
}

export async function createSessionRecord(input: {
  orgId?: string | null;
  personaSlug: string; personaVersion: number;
  agentSlug: string; agentVersion: number;
  domainSlug: string; domainVersion: number;
  contextName?: string;
}) {
  return db.interviewSession.create({ data: input });
}

export async function endSessionRecord(id: string, status: string) {
  return db.interviewSession.update({ where: { id }, data: { status, endedAt: new Date() } });
}

