"use client";

import { toast } from "sonner";
import { twinClient } from "@/lib/twin/client";

/** Copies the twin's common link (each person who opens it gets their own minutes). */
export async function copyTwinLink(slug: string) {
  try {
    const { url, minutesPerUser } = await twinClient.agents.shareLink.mutate({ slug });
    await navigator.clipboard.writeText(url);
    toast.success(`Link copied. Each person who opens it gets ${minutesPerUser} minutes.`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not create the link");
  }
}
