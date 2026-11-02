"use client";

import { TwinAvatarCapture } from "@/components/twin/twin-avatar-capture";
import { api, useApi } from "@/lib/api";

/** The twin's avatar: a photo taken or uploaded, kept as is or as one of the AI versions made from it. */
export default function TwinAvatarRoute() {
  const state = useApi(["twin.avatar.get"], () => api.twin.avatar.get.query());
  return <TwinAvatarCapture personaName={state?.personaName ?? null} />;
}
