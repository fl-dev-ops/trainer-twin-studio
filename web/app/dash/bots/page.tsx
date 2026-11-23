"use client";

import { TwinBotsPage } from "@/components/twin/twin-bot-page";
import { api, useApi } from "@/lib/api";

/** Bots: every bot, and New bot. */
export default function BotsRoute() {
  const data = useApi(["twin.bots"], () => api.twin.bots.list.query());
  return <TwinBotsPage data={data} />;
}
