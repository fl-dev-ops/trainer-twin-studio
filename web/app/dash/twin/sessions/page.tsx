"use client";

import { TwinSessionsPage } from "@/components/twin/twin-sessions-page";
import { api, useApi } from "@/lib/api";

export default function TwinSessionsRoute() {
  const sessions = useApi(["twin.sessions.list"], () => api.twin.sessions.list.query());
  return <TwinSessionsPage sessions={sessions} />;
}
