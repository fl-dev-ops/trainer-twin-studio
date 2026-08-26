import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import {
  createKnowledgeBase,
  deleteKnowledge,
  digestKnowledge,
  getKnowledgePreviewUrl,
  listKnowledgeBases,
  listKnowledgeFiles,
  removeEmbeddings,
  uploadKnowledgeFile,
} from "@/lib/specs";

type Params = { params: Promise<{ kb?: string[] }> };

export async function GET(_req: Request, { params }: Params) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kb } = await params;
  if (!kb) {
    const bases = await listKnowledgeBases(org.id);
    return NextResponse.json({
      knowledgeBases: bases.map((b) => ({ slug: b.slug, name: b.name })),
    });
  }

  const [base, ...rest] = kb;
  if (rest.length === 0) {
    return NextResponse.json({ files: await listKnowledgeFiles(org.id, base) });
  }
  if (rest[0] === "preview") {
    const url = await getKnowledgePreviewUrl(org.id, base, rest[1]);
    if (!url) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ url });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** POST /api/knowledge/<kb>            → create base (JSON {slug}) or upload file (multipart) */
/** POST /api/knowledge/<kb>/digest[/<file>] → index into ChromaDB */
export async function POST(req: Request, { params }: Params) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kb } = await params;
  if (!kb || kb.length < 1) {
    return NextResponse.json({ error: "Expected /api/knowledge/<kb>" }, { status: 400 });
  }
  const [base, action, file] = kb;

  try {
    if (action === "digest") {
      const result = await digestKnowledge(org.id, base, file);
      return NextResponse.json({ ok: true, ...result });
    }
    if (action) {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "Missing file" }, { status: 400 });
      }
      const result = await uploadKnowledgeFile(org.id, base, file);
      try {
        const digestion = await digestKnowledge(org.id, base, result.slug);
        return NextResponse.json({ ok: true, ...result, indexed: digestion.indexed });
      } catch (error) {
        // The source is safely uploaded and the document is marked failed for retry.
        return NextResponse.json({
          ok: true,
          ...result,
          indexed: 0,
          indexError: error instanceof Error ? error.message : "Indexing failed",
        });
      }
    }
    const body = await req.json().catch(() => null);
    await createKnowledgeBase(org.id, typeof body?.slug === "string" ? body.slug : base);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kb } = await params;
  if (!kb || kb.length < 1) {
    return NextResponse.json({ error: "Expected /api/knowledge/<kb>[/<file>]" }, { status: 400 });
  }
  const [base, ...rest] = kb;
  try {
    // remove embeddings before dropping the records
    if (rest.length > 0) {
      const doc = await listKnowledgeFiles(org.id, base);
      const target = doc.find((d) => d.slug === rest.join("/"));
      if (target) await removeEmbeddings(base, [target.id]);
    }
    await deleteKnowledge(org.id, base, rest.length > 0 ? rest.join("/") : undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 400 },
    );
  }
}
