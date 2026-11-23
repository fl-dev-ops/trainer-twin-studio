"use client";

import { useSearchParams } from "next/navigation";
import { TwinBotsPage } from "@/components/twin/twin-bot-page";
import { api, useApi } from "@/lib/api";

/** Website bots: every bot, and New bot (?new=<twin slug> opens it for that twin, from the twin's settings). */
export default function TwinBotsRoute() {
  const data = useApi(["twin.bots"], () => api.twin.bots.list.query());
  return <TwinBotsPage data={data} startFor={useSearchParams().get("new")} />;
}
