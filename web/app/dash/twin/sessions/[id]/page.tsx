"use client";

import { useParams } from "next/navigation";
import { TwinSessionDetailPage } from "@/components/twin/twin-session-detail-page";
import { api, useApi } from "@/lib/api";

export default function TwinSessionDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const session = useApi(["twin.sessions.get", id], () => api.twin.sessions.get.query({ id }));
  return <TwinSessionDetailPage session={session} />;
}
