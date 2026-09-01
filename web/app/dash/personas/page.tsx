import { redirect } from "next/navigation";
import { SpecResourceIndex } from "@/components/spec-resource";
import { getSessionOrg } from "@/lib/org";
import { listSpecSummaries } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function PersonasPage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  return <SpecResourceIndex type="personas" specs={await listSpecSummaries("personas", org.id)} basePath={org.basePath} />;
}
