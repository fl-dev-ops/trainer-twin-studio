import { SpecResourcePage } from "@/components/spec-resource-page";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const [{ slug }, { version }] = await Promise.all([params, searchParams]);
  return <SpecResourcePage type="agents" slug={slug} requestedVersion={version} />;
}
