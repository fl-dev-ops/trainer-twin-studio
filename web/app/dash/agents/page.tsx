"use client";

import { SpecResourceIndex } from "@/components/spec-resource";
import { api, useApi } from "@/lib/api";

export default function AgentsPage() {
  const specs = useApi(["page.agents"], () => api.page.agents.query());
  return <SpecResourceIndex type="agents" specs={specs} />;
}
