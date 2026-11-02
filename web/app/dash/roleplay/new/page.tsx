"use client";

import { RoleplayBuilderPage } from "@/components/roleplay/roleplay-builder-page";
import { api, useApi } from "@/lib/api";

const NOTHING_BEFORE = { preScreenshare: false, preUpload: false, duringUpload: false, uploadTitle: "", uploadInstruction: "" };

/** Build a new role play. */
export default function NewRoleplayRoute() {
  const personas = useApi(["roleplay.builder.personas"], () => api.roleplay.builder.personas.query());
  return <RoleplayBuilderPage before={NOTHING_BEFORE} personas={personas} />;
}
