"use client";

import { RoleplaySessionsPage } from "@/components/roleplay/roleplay-sessions-page";
import { api, useApi } from "@/lib/api";

/** Role play sessions: practice sessions on the org's role plays. */
export default function RoleplaySessionsRoute() {
  const sessions = useApi(["roleplay.sessions.list"], () => api.roleplay.sessions.list.query());
  return <RoleplaySessionsPage sessions={sessions} />;
}
