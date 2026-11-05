import { getObjectBytes } from "@/lib/s3";

/** An upload's bytes (ContextDocument): S3, or the bytes older uploads kept in Postgres (lib/uploads.ts). */
export async function uploadBytes(doc: { s3Key: string | null; content: Uint8Array | null }): Promise<Uint8Array> {
  if (doc.s3Key) return getObjectBytes(doc.s3Key);
  if (doc.content) return new Uint8Array(doc.content);
  throw new Error("This file has no content");
}
