import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_BUCKET?.trim() ?? "";
const region = process.env.AWS_REGION?.trim() ?? "us-east-1";
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

export function voicePrefix(orgId: string, voiceId: string) {
  return `${orgPrefix(orgId)}/tts-voices/${voiceId}`;
}

export function recordingKey(orgId: string, sessionId: string) {
  return `${orgPrefix(orgId)}/recordings/${sessionId}.wav`;
}

export function personaSourcePrefix(orgId: string, personaId: string, sourceId?: string) {
  return sourceId
    ? `${orgPrefix(orgId)}/personas/${personaId}/sources/${sourceId}`
    : `${orgPrefix(orgId)}/personas/${personaId}/sources`;
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

export async function presignedGetUrl(key: string, expiresIn = 3600) {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
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

