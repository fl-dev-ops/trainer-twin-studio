"use client";

import { useSearchParams } from "next/navigation";
import { UsagePage } from "@/components/usage/usage-page";
import { api, useApi } from "@/lib/api";

export default function UsageRoute() {
  const tab = useSearchParams().get("tab");
  const credits = useApi(["page.usage"], () => api.minutes.org.query());
  return <UsagePage credits={credits} initialTab={tab} />;
}
