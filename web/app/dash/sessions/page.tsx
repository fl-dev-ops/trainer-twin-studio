"use client";

import { useSearchParams } from "next/navigation";
import { SessionsList } from "@/components/sessions/sessions-list";
import { api, useApi } from "@/lib/api";

export default function SessionsPage() {
  const query = useSearchParams();
  const filters = {
    range: query.get("range") ?? undefined,
    scenario: query.get("scenario") ?? undefined,
    learner: query.get("learner") ?? undefined,
  };
  const data = useApi(["page.sessions", filters], () => api.page.sessions.query(filters));
  return <SessionsList data={data} />;
}
