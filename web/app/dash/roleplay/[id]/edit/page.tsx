import { notFound } from "next/navigation";
import { RoleplayBuilderPage } from "@/components/roleplay/roleplay-builder-page";
import { orNotFound, roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** Edit a role play in the builder (Before / During / After). */
export default async function EditRoleplayRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roleplay = await roleplayServer();
  const [saved, personas] = await Promise.all([orNotFound(roleplay.builder.get({ slug: id })), roleplay.builder.personas()]);
  if (!saved.builder) notFound();
  return <RoleplayBuilderPage slug={saved.slug} initial={saved.builder} before={saved.before} personas={personas} />;
}
