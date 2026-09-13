import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { documentToMarkdown } from "@/lib/documents";

export const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024; // 20 MB

export const SUPPORTED_DOC_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "csv",
  "txt",
  "md",
  "json",
]);
export const SUPPORTED_IMG_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

const EXT_ALLOWED_MIMES: Record<string, Set<string>> = {
  pdf: new Set(["application/pdf"]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
  ]),
  doc: new Set(["application/msword", "application/octet-stream"]),
  pptx: new Set([
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/octet-stream",
  ]),
  ppt: new Set(["application/vnd.ms-powerpoint", "application/octet-stream"]),
  xlsx: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ]),
  xls: new Set(["application/vnd.ms-excel", "application/octet-stream"]),
  csv: new Set(["text/csv", "text/plain", "application/vnd.ms-excel"]),
  txt: new Set(["text/plain"]),
  md: new Set(["text/markdown", "text/plain"]),
  json: new Set(["application/json", "text/plain"]),
  png: new Set(["image/png"]),
  jpg: new Set(["image/jpeg"]),
  jpeg: new Set(["image/jpeg"]),
  webp: new Set(["image/webp"]),
};

export interface DocumentManifest {
  id: string;
  name: string;
  kind: "document" | "image";
  mimeType: string;
  size: number;
  pageCount?: number;
  headings?: string[];
  summary?: string;
  width?: number;
  height?: number;
}

export interface PreparedChunk {
  chunkIndex: number;
  heading: string | null;
  pageNumber: number | null;
  text: string;
}

export interface PreparedContextDocument {
  name: string;
  kind: "document" | "image";
  mimeType: string;
  size: number;
  sha256: string;
  extractedText: string | null;
  manifest: DocumentManifest;
  chunks: PreparedChunk[];
}

export function sanitizeTextToken(value: string, maxLength = 80): string {
  return value
    .replace(/[\r\n\t\x00-\x1F\x7F]+/g, " ")
    .replace(/[<>{}[\]]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function inspectImage(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return { width, height };
      }
      const length = view.getUint16(offset + 2);
      offset += 2 + length;
    }
  }

  // WebP: RIFF ... WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    // VP8 chunk
    if (bytes.length >= 30 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return { width, height };
    }
    // VP8L (lossless)
    if (bytes.length >= 25 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
    // VP8X (extended)
    if (bytes.length >= 30 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height };
    }
  }

  return null;
}

export function chunkMarkdownText(text: string): PreparedChunk[] {
  const lines = text.split("\n");
  const chunks: PreparedChunk[] = [];
  let currentHeading: string | null = null;
  let currentBuffer: string[] = [];

  const flush = () => {
    const content = currentBuffer.join("\n").trim();
    if (content.length > 0) {
      // If a section is large (>1500 chars), subdivide it along paragraph boundaries
      if (content.length > 1500) {
        const paragraphs = content.split(/\n\s*\n/);
        let subBuffer: string[] = [];
        for (const p of paragraphs) {
          if (subBuffer.join("\n\n").length + p.length > 1200 && subBuffer.length > 0) {
            chunks.push({
              chunkIndex: chunks.length,
              heading: currentHeading,
              pageNumber: null,
              text: subBuffer.join("\n\n").trim(),
            });
            subBuffer = [];
          }
          subBuffer.push(p);
        }
        if (subBuffer.length > 0) {
          chunks.push({
            chunkIndex: chunks.length,
            heading: currentHeading,
            pageNumber: null,
            text: subBuffer.join("\n\n").trim(),
          });
        }
      } else {
        chunks.push({
          chunkIndex: chunks.length,
          heading: currentHeading,
          pageNumber: null,
          text: content,
        });
      }
    }
    currentBuffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = sanitizeTextToken(headingMatch[1]);
    } else {
      currentBuffer.push(line);
    }
  }
  flush();

  return chunks;
}

export async function prepareContextDocument(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  tempId = ""
): Promise<PreparedContextDocument> {
  if (bytes.length > MAX_DOCUMENT_SIZE) {
    throw new Error(`File exceeds maximum size of ${Math.round(MAX_DOCUMENT_SIZE / 1024 / 1024)}MB`);
  }

  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const isDoc = SUPPORTED_DOC_EXTS.has(ext);
  const isImg = SUPPORTED_IMG_EXTS.has(ext);

  if (!isDoc && !isImg) {
    throw new Error(
      `Unsupported file type .${ext}. Supported: ${[...SUPPORTED_DOC_EXTS, ...SUPPORTED_IMG_EXTS].join(", ")}`
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const declaredMime = mimeType.toLowerCase().split(";")[0].trim();
  const allowedMimes = EXT_ALLOWED_MIMES[ext];
  if (declaredMime && declaredMime !== "application/octet-stream" && allowedMimes && !allowedMimes.has(declaredMime)) {
    throw new Error(`Declared MIME type ${declaredMime} does not match file extension .${ext}`);
  }

  if (isImg) {
    const dims = inspectImage(bytes);
    if (!dims) throw new Error("Image content does not match a supported PNG, JPEG, or WebP file");
    const cleanMime =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/jpeg";
    if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== cleanMime) {
      throw new Error(`File MIME type ${declaredMime} does not match .${ext}`);
    }

    const manifest: DocumentManifest = {
      id: tempId,
      name,
      kind: "image",
      mimeType: cleanMime,
      size: bytes.length,
      width: dims.width,
      height: dims.height,
      summary: `Image: ${name} (${dims.width}x${dims.height})`,
    };

    return {
      name,
      kind: "image",
      mimeType: cleanMime,
      size: bytes.length,
      sha256,
      extractedText: null,
      manifest,
      chunks: [],
    };
  }

  // Document branch (PDF, TXT, MD, JSON, CSV)
  if (ext === "pdf") {
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    if (header !== "%PDF-") throw new Error("File content does not match a PDF");
    if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== "application/pdf") {
      throw new Error(`File MIME type ${declaredMime} does not match .pdf`);
    }
  } else {
    if (bytes.includes(0)) throw new Error("Text document contains binary data");
    if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== "application/json" && declaredMime !== "text/plain" && declaredMime !== "text/markdown" && declaredMime !== "text/csv") {
      throw new Error(`Unsupported MIME type ${declaredMime} for a text document`);
    }
    if (ext === "json") {
      try {
        JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("Invalid JSON document");
      }
    }
  }

  let pageCount: number | undefined;
  if (ext === "pdf") {
    try {
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      pageCount = pdfDoc.getPageCount();
    } catch {
      // Keep pageCount undefined if pdf structure is non-standard
    }
  }

  const fileObj = new File([bytes as unknown as BlobPart], name, { type: mimeType });
  const { markdown } = await documentToMarkdown(fileObj);

  const chunks = chunkMarkdownText(markdown);
  const headings = Array.from(
    new Set(chunks.map((c) => c.heading).filter((h): h is string => Boolean(h)))
  ).slice(0, 10);

  const summary = headings.length
    ? `Sections: ${headings.join(", ")}`
    : `Document: ${name} (${pageCount ? `${pageCount} pages, ` : ""}${chunks.length} sections)`;

  const manifest: DocumentManifest = {
    id: tempId,
    name,
    kind: "document",
    mimeType: mimeType || (ext === "pdf" ? "application/pdf" : "text/plain"),
    size: bytes.length,
    pageCount,
    headings,
    summary,
  };

  return {
    name,
    kind: "document",
    mimeType: manifest.mimeType,
    size: bytes.length,
    sha256,
    extractedText: markdown,
    manifest,
    chunks,
  };
}

export function searchDocumentChunks<
  T extends { id?: string; chunkIndex: number; heading: string | null; text: string }
>(chunks: T[], query: string, limit = 3): T[] {
  if (!chunks.length || !query.trim()) return [];

  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (!terms.length) return chunks.slice(0, limit);

  const scored = chunks.map((chunk) => {
    const textLower = chunk.text.toLowerCase();
    const headingLower = (chunk.heading ?? "").toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (headingLower.includes(term)) score += 3;
      if (textLower.includes(term)) score += 1;
    }

    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.chunk);
}

export function formatSessionDocumentManifestText(manifests: DocumentManifest[]): string {
  if (!manifests.length) {
    return "None attached. Do not claim to see any document or image.";
  }

  return manifests
    .slice(0, 6)
    .map((m) => {
      const cleanName = sanitizeTextToken(m.name, 60);
      if (m.kind === "image") {
        return `- [${m.id}] "${cleanName}" (Image${m.width && m.height ? `, ${m.width}x${m.height}` : ""})`;
      }
      const pagePart = m.pageCount ? `, ${m.pageCount} page${m.pageCount > 1 ? "s" : ""}` : "";
      const cleanHeadings = (m.headings ?? []).map((h) => sanitizeTextToken(h, 40)).filter(Boolean).slice(0, 5);
      const headingsPart = cleanHeadings.length ? ` — Sections: ${cleanHeadings.join(", ")}` : "";
      return `- [${m.id}] "${cleanName}" (Document${pagePart})${headingsPart}`;
    })
    .join("\n")
    .slice(0, 1500);
}
