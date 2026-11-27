import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = (process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "").trim();
const region = (process.env.AWS_REGION || "ap-south-1").trim();
const basePrefix = (process.env.S3_BASE_PREFIX?.trim() || "trainertwin-dev").replace(/^\/+|\/+$/g, "");

export const s3Configured = Boolean(bucket && process.env.AWS_ACCESS_KEY_ID);

function client() {
  return new S3Client({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
        }
      : undefined,
  });
}

export function orgPrefix(orgId: string) {
  return `${basePrefix}/${orgId}`;
}

export function kbPrefix(orgId: string, knowledgeBaseId: string, docId?: string) {
  return docId
    ? `${orgPrefix(orgId)}/knowledge/${knowledgeBaseId}/${docId}`
    : `${orgPrefix(orgId)}/knowledge/${knowledgeBaseId}`;
}

export function voicePrefix(orgId: string | null, voiceId: string) {
  return `${orgId ? orgPrefix(orgId) : `${basePrefix}/global`}/tts-voices/${voiceId}`;
}

/** Where the built-in sample voices live: `shared/` at the root of the bucket's app folder (the first segment of the base prefix, e.g. trainertwin-dev/shared even when the base is trainertwin-dev/kb). */
export function sampleVoicePrefix(voiceId: string) {
  return `${basePrefix.split("/")[0]}/shared/tts-voices/${voiceId}`;
}

/** Persona avatar reference files (image + video). Global presets (no org) live under `global/`. */
export function avatarPrefix(orgId: string | null, avatarId: string) {
  return `${orgId ? orgPrefix(orgId) : `${basePrefix}/global`}/avatars/${avatarId}`;
}

export function roleplayIntroKey(orgId: string, agentId: string, uploadId: string) {
  return `${orgPrefix(orgId)}/roleplays/${agentId}/intro/${uploadId}.mp4`;
}

export function recordingKey(orgId: string, sessionId: string) {
  return `${orgPrefix(orgId)}/recordings/${sessionId}.wav`;
}


export function personaSourcePrefix(orgId: string, personaId: string, sourceId?: string) {
  return sourceId
    ? `${orgPrefix(orgId)}/personas/${personaId}/sources/${sourceId}`
    : `${orgPrefix(orgId)}/personas/${personaId}/sources`;
}

/** Files from the scenario-ingest agent, kept exactly as it produced them. */
export function scenarioArtifactsPrefix(orgId: string, agentSlug: string, version: number) {
  return `${orgPrefix(orgId)}/scenario-ingest/scenarios/${agentSlug}/v${version}`;
}

export function scenarioRunPrefix(orgId: string, runId: string) {
  return `${orgPrefix(orgId)}/scenario-ingest/runs/${runId}`;
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function putObject(key: string, body: Uint8Array | string, contentType: string) {
  await client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectText(key: string): Promise<string> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await res.Body?.transformToString("utf-8")) ?? "";
}

export async function isUploadedMp4(key: string, maxBytes: number) {
  const response = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-11" })).catch((error: unknown) => {
    if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "InvalidRange")) return null;
    throw error;
  });
  if (!response?.Body) return false;
  const bytes = await response.Body.transformToByteArray();
  const size = Number(response.ContentRange?.split("/").at(-1));
  return response.ContentType === "video/mp4" && size >= 12 && size <= maxBytes
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

export async function presignedGetUrl(key: string, expiresIn = 3600) {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

/** Browser uploads straight to S3 (files too large to pass through the app); the bucket's CORS allows PUT. */
export async function presignedPutUrl(key: string, contentType: string, expiresIn = 600, contentLength?: number) {
  // A signed length makes S3 refuse a body of any other size (an upload can't exceed what was checked).
  return getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), {
    expiresIn,
    ...(contentLength ? { signableHeaders: new Set(["content-type", "content-length"]) } : {}),
  });
}

export async function copyObject(source: string, key: string) {
  const copySource = [bucket, ...source.split("/")].map(encodeURIComponent).join("/");
  await client().send(new CopyObjectCommand({ Bucket: bucket, CopySource: copySource, Key: key }));
}

export async function deleteObject(key: string) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Deletes every object under the given prefix with full pagination beyond 1,000 keys. */
export async function deletePrefix(prefix: string) {
  const client_ = client();
  let continuationToken: string | undefined = undefined;

  do {
    const listed: ListObjectsV2CommandOutput = await client_.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length > 0) {
      await client_.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

/** `key` when it is one of this org's files (under orgPrefix), else null: never sign another org's file (practice rule 27). */
export function orgOwnKey(orgId: string, key: unknown): string | null {
  return typeof key === "string" && key.startsWith(`${orgPrefix(orgId)}/`) && !key.includes("..") ? key : null;
}
