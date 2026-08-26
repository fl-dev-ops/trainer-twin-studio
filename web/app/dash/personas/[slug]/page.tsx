import { SpecResourcePage } from "@/components/spec-resource-page";

export default async function PersonaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const [{ slug }, { version }] = await Promise.all([params, searchParams]);
  return <SpecResourcePage type="personas" slug={slug} requestedVersion={version} />;
}
