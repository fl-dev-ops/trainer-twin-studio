"use client";

import { useParams } from "next/navigation";
import { RoleplayDetailPage } from "@/components/roleplay/roleplay-detail-page";
import { api, useApi } from "@/lib/api";

/** One role play: client, scenario, report, members, sessions. */
export default function RoleplayDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const roleplay = useApi(["roleplay.scenarios.get", id], () => api.roleplay.scenarios.get.query({ slug: id }));
  return <RoleplayDetailPage roleplay={roleplay} />;
}
