"use client";

import { useParams } from "next/navigation";
import { RoleplayBuilderPage } from "@/components/roleplay/roleplay-builder-page";
import { api, pageNotFound, useApi } from "@/lib/api";

/** Edit a role play in the builder (Before / During / After). */
export default function EditRoleplayRoute() {
  const { id } = useParams<{ id: string }>();
  const [saved, personas] = useApi(["roleplay.edit", id], () =>
    Promise.all([api.roleplay.builder.get.query({ slug: id }), api.roleplay.builder.personas.query()]),
  );
  if (!saved.builder) pageNotFound();
  return <RoleplayBuilderPage slug={saved.slug} initial={saved.builder} before={saved.before} tools={saved.tools} personas={personas} />;
}
