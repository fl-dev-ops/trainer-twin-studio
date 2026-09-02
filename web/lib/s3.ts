import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_BUCKET?.trim() ?? "";
const region = process.env.AWS_REGION?.trim() ?? "us-east-1";
const basePrefix = (process.env.S3_BASE_PREFIX?.trim() ?? "trainertwin/kb").replace(/^\/+|\/+$/g, "");

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

export function kbPrefix(orgId: string, kbSlug: string, docId?: string) {
  return docId ? `${basePrefix}/${orgId}/${kbSlug}/${docId}` : `${basePrefix}/${orgId}/${kbSlug}`;
}

export function voicePrefix(voiceId: string) {
  return `${basePrefix}/tts-voices/${voiceId}`;
}

export function recordingKey(sessionId: string) {
  return `${basePrefix}/recordings/${sessionId}.wav`;
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

/** Deletes every object under the given prefix (up to 1000 keys per call). */
export async function deletePrefix(prefix: string) {
  const client_ = client();
  const listed = await client_.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
  if (keys.length === 0) return;
  await client_.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
}

