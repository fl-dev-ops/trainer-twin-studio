"use client";

import { useParams, useSearchParams } from "next/navigation";
import { SpecResourcePage } from "@/components/spec-resource-page";
import { api, useApi } from "@/lib/api";

export default function AgentEditPage() {
  const { slug } = useParams<{ slug: string }>();
  const query = useSearchParams();
  const version = query.get("version") ?? undefined;
  const isNew = query.get("new") === "1";
  const loaded = useApi(["page.agentSpec", slug, version, isNew], () => api.page.agentSpec.query({ slug, version, isNew }));
  return <SpecResourcePage loaded={loaded} />;
}
