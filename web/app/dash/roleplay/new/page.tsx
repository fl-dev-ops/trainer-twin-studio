"use client";

import { RoleplayCreatePage } from "@/components/roleplay/roleplay-create-page";
import { api, useApi } from "@/lib/api";

/** A new role play: one box; the copilot writes it from the trainer's words. */
export default function NewRoleplayRoute() {
  const personas = useApi(["roleplay.builder.personas"], () => api.roleplay.builder.personas.query());
  return <RoleplayCreatePage personas={personas} />;
}
