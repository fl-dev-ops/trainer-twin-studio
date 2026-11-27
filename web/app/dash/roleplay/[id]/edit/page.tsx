"use client";

import { useParams } from "next/navigation";
import { RoleplayBriefEditPage } from "@/components/roleplay/roleplay-brief-edit-page";
import { RoleplayBuilderPage } from "@/components/roleplay/roleplay-builder-page";
import { api, pageNotFound, useApi } from "@/lib/api";

/** Edit a role play in the builder (Before / During / After). */
export default function EditRoleplayRoute() {
  const { id } = useParams<{ id: string }>();
  const [saved, personas, pool] = useApi(["roleplay.edit", id], () =>
    Promise.all([api.roleplay.builder.get.query({ slug: id }), api.roleplay.builder.personas.query(), api.roleplay.builder.personaPool.query({ slug: id })]),
  );
  // Every role play: the simple edit page (basics, persona, read-only script, settings).
  if (saved.brief) return <RoleplayBriefEditPage slug={saved.slug} brief={saved.brief} before={saved.before} hasIntroVideo={saved.hasIntroVideo} tools={saved.tools} personas={personas} pool={pool} />;
  if (!saved.builder) pageNotFound();
  return <RoleplayBuilderPage slug={saved.slug} initial={saved.builder} character={saved.character} before={saved.before} tools={saved.tools} personas={personas} />;
}
