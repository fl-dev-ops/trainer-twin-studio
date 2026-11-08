"use client";

import { CreditsPage } from "@/components/credits/credits-page";
import { api, useApi } from "@/lib/api";

export default function CreditsRoute() {
  const credits = useApi(["page.credits"], () => api.minutes.org.query());
  return <CreditsPage credits={credits} />;
}
