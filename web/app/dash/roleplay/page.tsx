"use client";

import { RoleplayLibraryPage } from "@/components/roleplay/roleplay-library-page";
import { api, useApi } from "@/lib/api";

/** Scenarios — the role-play library. */
export default function RoleplayPage() {
  const scenarios = useApi(["roleplay.scenarios.list"], () => api.roleplay.scenarios.list.query());
  return <RoleplayLibraryPage scenarios={scenarios} />;
}
