/**
 * Client-side cache for scenario intro videos.
 *
 * Downloads happen on the pre-join screen so a slow intro (e.g. 100 MB) is fully
 * buffered before the session starts. The agent worker holds its greeting until the
 * client sends "begin-opening" (see agent/src/agent.py), so keeping that video's
 * data warm is what guarantees the two never overlap.
 *
 * Module-level cache = page lifetime: the blob survives the pre-join → session
 * transition (and React remounts) without re-downloading.
 */

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function getCachedIntroUrl(src: string): string | null {
  return cache.get(src) ?? null;
}

export type IntroDownloadProgress = {
  /** 0..1 based on Content-Length; undefined when the server sends no length. */
  ratio?: number;
  receivedBytes: number;
  totalBytes?: number;
};

/**
 * Fetches the video as a blob, streaming so the UI can show download progress.
 * Concurrent callers for the same src share one download. A failed download
 * rejects for every sharer and is retried on the next call.
 */
export async function downloadIntroVideo(
  src: string,
  onProgress?: (progress: IntroDownloadProgress) => void,
): Promise<string> {
  const cached = cache.get(src);
  if (cached) return cached;

  const existing = inflight.get(src);
  if (existing) {
    if (onProgress) existing.then(() => onProgress({ receivedBytes: 0, ratio: 1 })).catch(() => {});
    return existing;
  }

  const download = (async () => {
    const res = await fetch(src);
    if (!res.ok || !res.body) throw new Error(`Intro video download failed (${res.status})`);
    const totalHeader = res.headers.get("content-length");
    const totalBytes = totalHeader ? Number(totalHeader) : undefined;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        receivedBytes += value.byteLength;
        if (onProgress && totalBytes) {
          onProgress({ ratio: Math.min(1, receivedBytes / totalBytes), receivedBytes, totalBytes });
        }
      }
    }
    const type = res.headers.get("content-type") ?? "video/mp4";
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type }));
    chunks.length = 0;
    cache.set(src, url);
    return url;
  })();

  inflight.set(src, download);
  try {
    return await download;
  } finally {
    if (inflight.get(src) === download) inflight.delete(src);
  }
}
