"use client";

import { useParams } from "next/navigation";
import { TwinAgentDetailPage } from "@/components/twin/twin-agent-detail-page";
import { api, useApi } from "@/lib/api";

export default function TwinAgentDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const twin = useApi(["twin.agents.get", id], () => api.twin.agents.get.query({ slug: id }));
  return <TwinAgentDetailPage twin={twin} />;
}
