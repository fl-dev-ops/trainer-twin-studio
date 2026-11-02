"use client";

import { TwinAgentsPage } from "@/components/twin/twin-agents-page";
import { api, useApi } from "@/lib/api";

/** Twin agents — the Twin Agents library. */
export default function TwinPage() {
  const [data, personaSlug] = useApi(["twin.library"], () =>
    Promise.all([api.twin.agents.list.query(), api.page.ownTwinPersona.query()]),
  );
  return <TwinAgentsPage data={data} personaSlug={personaSlug} />;
}
