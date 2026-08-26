import yaml from "js-yaml";
import { readSpecDraft } from "@/lib/spec-drafts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; type: string }> },
) {
  const { slug, type } = await params;
  if (type !== "agent" && type !== "domain") {
    return Response.json({ error: "Type must be agent or domain" }, { status: 400 });
  }
  const draft = await readSpecDraft(slug);
  if (!draft) return Response.json({ error: `Draft "${slug}" was not found` }, { status: 404 });
  const document = { schema_version: 1, kind: type, [type]: draft[type] };
  return new Response(yaml.dump(document, { noRefs: true, lineWidth: 100 }), {
    headers: {
      "content-disposition": `attachment; filename="${slug}.${type}.yaml"`,
      "content-type": "application/yaml; charset=utf-8",
    },
  });
}
