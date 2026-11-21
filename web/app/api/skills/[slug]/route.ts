import { errorResponse } from "@/lib/errors";
import { studioOrg } from "@/lib/org";
import { readSkillRegistry } from "@/lib/skills";

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const org = await studioOrg();
    const { slug } = await context.params;
    const skill = await readSkillRegistry(org.id, slug);
    return Response.json({
      id: skill.id, name: skill.name, currentVersionId: skill.currentVersionId,
      versions: skill.versions.map((version) => ({
        id: version.id, version: version.version, format: version.format, status: version.status,
        indexStatus: version.indexStatus, contentHash: version.contentHash,
        artifacts: version.artifacts, itemCount: version.itemCount, failure: version.failure,
        createdAt: version.createdAt,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
