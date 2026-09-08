import { SpecResourcePage } from "@/components/spec-resource-page";

export default async function AgentEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string; new?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  return <SpecResourcePage type="agents" slug={slug} requestedVersion={query.version} isNew={query.new === "1"} />;
}
