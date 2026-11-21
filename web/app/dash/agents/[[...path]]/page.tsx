import { redirect } from "next/navigation";
import { roleplayPathFor } from "@/lib/agents-redirect";

/**
 * /agents is gone: every role play lives under /roleplay (plans/agents-to-roleplay.md). Old links and bookmarks land
 * on the same role play.
 */
export default async function AgentsRedirect({ params }: { params: Promise<{ path?: string[] }> }) {
  const [slug, page, id] = (await params).path ?? [];
  redirect(roleplayPathFor(slug, page, id));
}
