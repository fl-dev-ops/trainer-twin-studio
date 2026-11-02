"use client";

import { TwinBrainPage } from "@/components/twin/twin-brain-page";
import { api, useApi } from "@/lib/api";

/** Twin's brain. Knowledge (connectors + recent uploads) and voice/avatar are real; coaching style is fixed text for now. */
export default function TwinBrainRoute() {
  const { knowledge, avatar } = useApi(["page.twinBrain"], () => api.page.twinBrain.query());
  return <TwinBrainPage knowledge={knowledge} avatar={avatar} />;
}
