"use client";

import { useSearchParams } from "next/navigation";
import { KnowledgeView } from "@/components/knowledge";
import { api, useApi } from "@/lib/api";

export default function KnowledgePage() {
  const params = useSearchParams();
  const drive = params.get("drive");
  const { initialDocs, initialStats } = useApi(["page.twinKnowledge"], () => api.page.twinKnowledge.query());
  return <KnowledgeView initialDocs={initialDocs} initialStats={initialStats} initialDriveConnected={drive === "connected"} initialDocId={params.get("doc")} />;
}
