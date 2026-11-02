"use client";

import { useSearchParams } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { api, useApi } from "@/lib/api";

export default function TalkPage() {
  const agent = useSearchParams().get("agent") ?? undefined;
  const props = useApi(["page.talk", agent], () => api.page.talk.query({ agent }));
  return <SessionView {...props} />;
}
