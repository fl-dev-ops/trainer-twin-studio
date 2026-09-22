import { describe, expect, it } from "bun:test";
import {
  chunkMarkdownText,
  formatSessionDocumentManifestText,
  inspectImage,
  prepareContextDocument,
  searchDocumentChunks,
} from "../../../lib/context-document-service";

describe("session context document preparation", () => {
  it("chunks markdown by heading and retrieves the relevant section", () => {
    const chunks = chunkMarkdownText([
      "# Experience",
      "Built a Redis cache serving 50k requests per second.",
      "",
      "# Education",
      "Studied computer science.",
    ].join("\n"));

    expect(chunks).toHaveLength(2);
    expect(searchDocumentChunks(chunks, "redis throughput")[0]?.heading).toBe("Experience");
  });

  it("prepares JSON synchronously and rejects invalid JSON", async () => {
    const valid = await prepareContextDocument(
      "profile.json",
      "application/json",
      new TextEncoder().encode('{"role":"engineer"}')
    );
    expect(valid.kind).toBe("document");
    expect(valid.extractedText).toContain("engineer");
    expect(valid.chunks.length).toBeGreaterThan(0);

    await expect(
      prepareContextDocument("profile.json", "application/json", new TextEncoder().encode("not-json"))
    ).rejects.toThrow("Invalid JSON document");
  });

  it("recognizes PNG dimensions and rejects mismatched MIME types", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 2, 0, 0, 0, 1, 0,
    ]);
    expect(inspectImage(png)).toEqual({ width: 512, height: 256 });

    const prepared = await prepareContextDocument("diagram.png", "image/png", png);
    expect(prepared.manifest.width).toBe(512);
    expect(prepared.manifest.height).toBe(256);

    await expect(prepareContextDocument("diagram.png", "image/jpeg", png)).rejects.toThrow(
      "does not match file extension .png"
    );
  });

  it("sanitizes long or dangerous headings", () => {
    const malicious = [
      "# <script>alert(1)</script> Very Long Heading That Exceeds The Permitted Character Limit And Should Be Truncated Cleanly",
      "Body text under the heading.",
    ].join("\n");
    const chunks = chunkMarkdownText(malicious);
    expect(chunks[0]?.heading).not.toContain("<script>");
    expect((chunks[0]?.heading ?? "").length).toBeLessThanOrEqual(80);
  });

  it("rejects mismatched extension and MIME types for text documents", async () => {
    await expect(
      prepareContextDocument("notes.txt", "application/json", new TextEncoder().encode("hello text"))
    ).rejects.toThrow("does not match file extension .txt");
  });

  it("keeps manifests small and never includes document body text", () => {
    const manifest = formatSessionDocumentManifestText([
      {
        id: "doc-1",
        name: "resume.pdf",
        kind: "document",
        mimeType: "application/pdf",
        size: 1000,
        pageCount: 2,
        headings: ["Experience", "Projects"],
      },
      {
        id: "img-1",
        name: "architecture.png",
        kind: "image",
        mimeType: "image/png",
        size: 500,
        width: 800,
        height: 600,
      },
    ]);

    expect(manifest).toContain("resume.pdf");
    expect(manifest).toContain("Experience, Projects");
    expect(manifest).toContain("architecture.png");
    expect(manifest).not.toContain("50k requests");
  });
});
