"use client";

import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/sessions/session-detail";
import { api, useApi } from "@/lib/api";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const data = useApi(["page.session", id], () => api.page.session.query({ id }));
  return <SessionDetail data={data} />;
}
