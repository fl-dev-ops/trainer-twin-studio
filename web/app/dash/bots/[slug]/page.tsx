"use client";

import { useParams } from "next/navigation";
import { TwinBotPage } from "@/components/twin/twin-bot-page";
import { api, useApi } from "@/lib/api";

/** One website bot's settings. */
export default function TwinBotRoute() {
  const { slug } = useParams<{ slug: string }>();
  const bot = useApi(["twin.bots", slug], () => api.twin.bots.get.query({ slug }));
  return <TwinBotPage bot={bot} />;
}
