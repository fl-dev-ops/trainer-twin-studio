"use client";

import { useParams } from "next/navigation";
import { RoleplaySessionReportPage } from "@/components/roleplay/roleplay-session-report-page";
import { api, useApi } from "@/lib/api";

/** One role-play session's report. */
export default function RoleplaySessionRoute() {
  const { id } = useParams<{ id: string }>();
  const session = useApi(["roleplay.sessions.get", id], () => api.roleplay.sessions.get.query({ id }));
  return <RoleplaySessionReportPage session={session} />;
}
