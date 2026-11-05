import { attachmentError, type FetchFileFunction } from "eve/channels";
import { studio, type StudioCtx } from "./studio";

/**
 * Files a trainer attaches in a copilot chat (plans/uploads-to-s3.md): the browser uploads to S3 first and sends a
 * file part pointing at trainertwin-upload://<id>; eve stages it through this. An image reaches the model as pixels; a
 * PDF comes as its text (<name>.md, opened with read_file), because the copilot's model refuses PDF file parts and a
 * refused part fails the whole conversation. Only the trainer's own uploads in this org (the studio checks), 30 days.
 */
export const UPLOAD_SCHEME = "trainertwin-upload://";

type Resolved = { name: string; mediaType: string; url?: string; data?: string };

export const fetchUpload: FetchFileFunction = async (url, context) => {
  if (!url.startsWith(UPLOAD_SCHEME)) return null;
  if (!context) throw attachmentError("This file isn't available.");
  let resolved: Resolved;
  try {
    resolved = await studio<Resolved>(context as unknown as StudioCtx, { action: "resolveUpload", documentId: url.slice(UPLOAD_SCHEME.length) });
  } catch (error) {
    throw attachmentError(error instanceof Error ? error.message : "This file isn't available.", { cause: error });
  }
  if (resolved.data) return { bytes: Buffer.from(resolved.data, "base64"), mediaType: resolved.mediaType, filename: resolved.name };
  const response = await fetch(resolved.url!, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw attachmentError("This file couldn't be loaded. Ask the trainer to attach it again.");
  return { bytes: Buffer.from(await response.arrayBuffer()), mediaType: resolved.mediaType, filename: resolved.name };
};

/**
 * What eve accepts for the copilot: images (up to 5 MB, arrive resized) and PDFs, declared as such by the composer;
 * fetchUpload always turns a PDF into its text (text/markdown), so no PDF bytes reach the model.
 */
export const UPLOAD_POLICY = { maxBytes: 10 * 1024 * 1024, allowedMediaTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf", "text/markdown"] };
