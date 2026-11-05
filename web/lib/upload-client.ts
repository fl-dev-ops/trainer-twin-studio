"use client";

/**
 * Uploads a file the way every upload works now (plans/uploads-to-s3.md): start (a pending record and an S3 link),
 * PUT straight to S3 (no 4.5 MB function cap), complete (the server checks the bytes). Returns the saved file.
 */
export type UploadedFile = { id: string; name: string; kind: string; size: number; manifest?: unknown };
export type UploadPurpose = "before" | "during" | "copilot";

const errorOf = async (response: Response, fallback: string) =>
  ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? fallback;

export async function uploadFile(file: File, options: { purpose: UploadPurpose; shareCode?: string | null }): Promise<UploadedFile> {
  const started = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      mimeType: file.type,
      size: file.size,
      purpose: options.purpose,
      ...(options.shareCode ? { shareCode: options.shareCode } : {}),
    }),
  });
  if (!started.ok) throw new Error(await errorOf(started, "Upload failed"));
  const { id, putUrl, contentType } = (await started.json()) as { id: string; putUrl: string; contentType: string };
  const put = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
  if (!put.ok) throw new Error("Upload failed. Try again.");
  const completed = await fetch(`/api/uploads/${encodeURIComponent(id)}/complete`, { method: "POST" });
  if (!completed.ok) throw new Error(await errorOf(completed, "Upload failed"));
  return (await completed.json()) as UploadedFile;
}

/** The message that tells the agent about a file attached mid-call: readable, and parsed by the chat bridge. */
export const attachedMessage = (file: { id: string; name: string }) => `I've attached a file: ${file.name} [ATTACHED ${file.id}]`;

/** A copilot message's file part points at the upload (copilot/agent/lib/uploads.ts resolves it for the model). */
export const copilotUploadUrl = (id: string) => `trainertwin-upload://${id}`;
/**
 * eve's stream gives the browser a sent file's name and type but not its URL, so the part's filename carries the
 * upload id ("<id>/<name>"). The model never sees it: the copilot's fetchFile names the staged file itself.
 */
export const copilotUploadFilename = (id: string, name: string) => `${id}/${name}`;
/** A sent file part's name, and where to open it when its filename carries an upload id. */
export function copilotUploadOf(filename: string | undefined) {
  const match = filename?.match(/^([0-9a-f-]{36})\/(.+)$/);
  return match ? { name: match[2], url: `/api/uploads/${match[1]}/view` } : { name: filename || "file", url: "" };
}
