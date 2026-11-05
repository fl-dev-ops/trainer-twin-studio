import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { prepareContextDocument, type DocumentManifest, type PreparedContextDocument } from "@/lib/context-document-service";
import { uploadAllowed, uploadProblem, type UploadWhen } from "@/lib/context-upload";
import { scheduleResumeClaimExtraction } from "@/lib/resume-claims";
import { uploadBytes } from "@/lib/upload-bytes";
import { deleteObject, getObjectBytes, orgPrefix, presignedGetUrl, presignedPutUrl, putObject } from "@/lib/s3";

export { uploadBytes };

/**
 * Every file a person uploads (before a call, during a call or calibration, in a copilot chat) is a ContextDocument
 * whose bytes live in S3 (plans/uploads-to-s3.md). The browser PUTs straight to S3 (no 4.5 MB function cap), then the
 * server checks the real bytes and extracts text. Agents get the id: files from before a call are read with
 * read_document; files attached during a conversation reach the model as file parts (trainertwin-upload://<id>).
 */

export type UploadPurpose = "before" | "during" | "copilot";
export const UPLOAD_PURPOSES = ["before", "during", "copilot"] as const;
export const COPILOT_UPLOAD_DAYS = 30;
/** The file-part URL an agent's fetchFile resolves (chat and copilot channels). */
export const UPLOAD_URL_SCHEME = "trainertwin-upload:";
export const uploadUrl = (id: string) => `${UPLOAD_URL_SCHEME}//${id}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const whenOf = (purpose: UploadPurpose): UploadWhen => (purpose === "before" ? "before" : "during");
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").slice(-120) || "file";
const kindOf = (name: string) => (/\.(png|jpe?g|webp)$/i.test(name) ? "image" : "document");
export const uploadKey = (orgId: string, id: string, name: string) => `${orgPrefix(orgId)}/uploads/${id}/${safeName(name)}`;
const json = (value: unknown) => value as Prisma.InputJsonValue;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// eve shows a file to the model as pixels only up to 3 MiB and 8000 px a side; past the margin below an image gets a
// model-ready copy (2048 px, JPEG) next to the original. Screenshot text stays readable at that size.
const MODEL_MAX_BYTES = 2.5 * 1024 * 1024;
const MODEL_MAX_SIDE = 4096;
const MODEL_FIT = 2048;

async function modelCopy(key: string, bytes: Uint8Array, manifest: DocumentManifest): Promise<string | null> {
  const side = Math.max(Number(manifest.width ?? 0), Number(manifest.height ?? 0));
  if (bytes.byteLength <= MODEL_MAX_BYTES && side <= MODEL_MAX_SIDE) return null;
  const resized = await sharp(Buffer.from(bytes)).rotate().resize({ width: MODEL_FIT, height: MODEL_FIT, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const modelKey = `${key}.model.jpg`;
  await putObject(modelKey, resized, "image/jpeg");
  return modelKey;
}

/** The record fields of a checked file (bytes verified, text extracted), ready to save. */
async function finalFields(id: string, key: string, prepared: PreparedContextDocument, bytes: Uint8Array) {
  const manifest: DocumentManifest & { modelKey?: string } = { ...prepared.manifest, id };
  if (prepared.kind === "image") {
    const modelKey = await modelCopy(key, bytes, manifest);
    if (modelKey) manifest.modelKey = modelKey;
  }
  return {
    name: prepared.name,
    mimeType: prepared.mimeType,
    kind: prepared.kind,
    size: prepared.size,
    sha256: prepared.sha256,
    extractedText: prepared.extractedText,
    manifest: json(manifest),
    chunks: {
      create: prepared.chunks.map((c) => ({ chunkIndex: c.chunkIndex, heading: c.heading, pageNumber: c.pageNumber, text: c.text })),
    },
  };
}

/** Step 1: a pending record and a presigned PUT for the browser (10 minutes, this exact content type). */
export async function startUpload(input: { orgId: string; userId: string; name: string; mimeType: string; size: number; purpose: UploadPurpose }) {
  const problem = uploadProblem({ name: input.name, size: input.size }, whenOf(input.purpose));
  if (problem) throw new UploadError(problem);
  const id = randomUUID();
  const key = uploadKey(input.orgId, id, input.name);
  const contentType = input.mimeType || "application/octet-stream";
  await db.contextDocument.create({
    data: {
      id,
      orgId: input.orgId,
      ownerUserId: input.userId,
      name: input.name,
      mimeType: contentType,
      kind: kindOf(input.name),
      size: input.size,
      s3Key: key,
      status: "pending",
      purpose: input.purpose,
      expiresAt: input.purpose === "copilot" ? new Date(Date.now() + COPILOT_UPLOAD_DAYS * DAY_MS) : null,
    },
  });
  return { id, putUrl: await presignedPutUrl(key, contentType, 600, input.size), contentType };
}

/** Step 2, after the browser's PUT: checks the real bytes, extracts text, marks it ready. A bad file is deleted. */
export async function completeUpload(input: { id: string; orgId: string; userId: string }) {
  const doc = await db.contextDocument.findFirst({
    where: { id: input.id, orgId: input.orgId, ownerUserId: input.userId, status: "pending" },
    select: { id: true, name: true, mimeType: true, s3Key: true, purpose: true },
  });
  if (!doc?.s3Key) throw new UploadError("Upload not found", 404);
  const key = doc.s3Key;
  try {
    const bytes = await getObjectBytes(key);
    const prepared = await prepareContextDocument(doc.name, doc.mimeType, bytes, doc.id);
    const when = whenOf(doc.purpose as UploadPurpose);
    if (!uploadAllowed({ kind: prepared.kind, mimeType: prepared.mimeType, size: prepared.size }, when)) {
      throw new UploadError(uploadProblem({ name: doc.name, size: prepared.size }, when) ?? "This file can't be used here.");
    }
    const saved = await db.contextDocument.update({
      where: { id: doc.id },
      data: { ...(await finalFields(doc.id, key, prepared, bytes)), status: "ready" },
      select: { id: true, name: true, kind: true, size: true, manifest: true },
    });
    scheduleResumeClaimExtraction(saved.id, saved.kind);
    return saved;
  } catch (error) {
    await deleteObject(key).catch(() => {});
    await db.contextDocument.update({ where: { id: doc.id }, data: { status: "failed" } }).catch(() => {});
    if (error instanceof UploadError) throw error;
    const message = error instanceof Error ? error.message : "Upload failed";
    // prepareContextDocument's own refusals (type, size, content) are the person's to fix.
    throw new UploadError(message, /Unsupported|does not match|exceeds/.test(message) ? 400 : 422);
  }
}

/** One step, on the server (the multipart route and the bench): store in S3 and save the checked record. */
export async function saveUploadToS3(input: { orgId: string; userId: string; name: string; mimeType: string; content: Uint8Array; purpose?: UploadPurpose }) {
  const prepared = await prepareContextDocument(input.name, input.mimeType, input.content);
  const id = randomUUID();
  const key = uploadKey(input.orgId, id, prepared.name);
  await putObject(key, input.content, prepared.mimeType);
  const doc = await db.contextDocument.create({
    data: {
      id,
      orgId: input.orgId,
      ownerUserId: input.userId,
      s3Key: key,
      status: "ready",
      purpose: input.purpose ?? "before",
      ...(await finalFields(id, key, prepared, input.content)),
    },
    select: { id: true, name: true, size: true, kind: true, manifest: true, createdAt: true },
  });
  scheduleResumeClaimExtraction(id, prepared.kind);
  return { ...doc, manifest: doc.manifest as unknown as DocumentManifest };
}

/**
 * For an agent's fetchFile: a ready upload of this org as a short-lived S3 link and its type. In a call (sessionId)
 * only a file attached to that session; in a copilot chat (ownerUserId) only the trainer's own uploads. Images come
 * as their model-ready copy.
 */
export async function resolveUpload(input: { orgId: string; id: string; sessionId?: string; ownerUserId?: string; pdfAsText?: boolean }) {
  const doc = await db.contextDocument.findFirst({
    where: { id: input.id, orgId: input.orgId, ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}) },
    select: { id: true, name: true, kind: true, mimeType: true, s3Key: true, content: true, status: true, manifest: true, expiresAt: true, extractedText: true },
  });
  if (!doc || doc.status === "failed" || doc.status === "pending") throw new UploadError("This file isn't available.", 404);
  if (doc.status === "expired" || (doc.expiresAt && doc.expiresAt < new Date())) throw new UploadError("This file has expired.", 410);
  if (input.sessionId) {
    const linked = await db.interviewSession.findFirst({
      where: { id: input.sessionId, orgId: input.orgId, OR: [{ contextId: doc.id }, { documents: { some: { documentId: doc.id } } }] },
      select: { id: true },
    });
    if (!linked) throw new UploadError("This file isn't attached to this conversation.", 403);
  }
  // For a model that can't read PDFs (the copilot's): the text extracted at upload, as a Markdown file it can open.
  // shortcut: a scanned PDF has no text here; render its pages to images if trainers attach those.
  if (input.pdfAsText && doc.mimeType === "application/pdf") {
    const text = doc.extractedText?.trim() || "(No text could be extracted from this PDF; it may be scanned.)";
    return { id: doc.id, name: `${doc.name}.md`, kind: doc.kind, mediaType: "text/markdown", data: Buffer.from(`# ${doc.name}\n\n${text}\n`).toString("base64") };
  }
  const modelKey = (doc.manifest as { modelKey?: unknown } | null)?.modelKey;
  if (typeof modelKey === "string") return { id: doc.id, name: doc.name, kind: doc.kind, mediaType: "image/jpeg", url: await presignedGetUrl(modelKey, 300) };
  if (doc.s3Key) return { id: doc.id, name: doc.name, kind: doc.kind, mediaType: doc.mimeType, url: await presignedGetUrl(doc.s3Key, 300) };
  // Older uploads (bytes in Postgres) come inline.
  return { id: doc.id, name: doc.name, kind: doc.kind, mediaType: doc.mimeType, data: Buffer.from(await uploadBytes(doc)).toString("base64") };
}

/**
 * Daily: deletes copilot uploads past their 30 days (the S3 objects go, the record stays as `expired`), and marks
 * uploads the browser never finished (pending for a day) as failed, deleting whatever reached S3.
 */
export async function expireUploads(now = new Date(), limit = 200) {
  const stale = await db.contextDocument.findMany({
    where: { status: "pending", createdAt: { lt: new Date(now.getTime() - DAY_MS) } },
    take: limit,
    select: { id: true, s3Key: true },
  });
  for (const doc of stale) {
    if (doc.s3Key) await deleteObject(doc.s3Key).catch(() => {});
    await db.contextDocument.update({ where: { id: doc.id }, data: { status: "failed" } });
  }
  const due = await db.contextDocument.findMany({
    where: { status: "ready", expiresAt: { lt: now } },
    take: limit,
    select: { id: true, s3Key: true, manifest: true },
  });
  for (const doc of due) {
    const modelKey = (doc.manifest as { modelKey?: unknown } | null)?.modelKey;
    await Promise.all([doc.s3Key ? deleteObject(doc.s3Key) : null, typeof modelKey === "string" ? deleteObject(modelKey) : null].map((p) => p?.catch(() => {})));
    await db.contextDocument.update({ where: { id: doc.id }, data: { status: "expired", content: null } });
  }
  return { expired: due.length, abandoned: stale.length };
}
