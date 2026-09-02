import { db } from "@/lib/db";
import { createConnectionStore } from "../../shared/youtube/connection-store.server";
import { createYouTubeClient } from "../../shared/youtube/client.server";
import { youtubeConfig } from "../../shared/youtube/http.server";

/** Prisma adapter for the shared token store; never imported by browser modules. */
export function youtubeClient() {
  return createYouTubeClient(createConnectionStore(<T>(sql: string, values: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...values)), youtubeConfig());
}
