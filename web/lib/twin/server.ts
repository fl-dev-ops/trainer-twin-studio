import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { requireStudioMember } from "@/lib/org";
import { createServerTrpcContext } from "@/lib/trpc";
import { twinRouter } from "@/lib/twin/trpc";

/** The twin tRPC router for a server component, as the signed-in studio member (others are sent away). */
export async function twinServer() {
  await requireStudioMember();
  // The router checks the role again on every procedure (studioProcedure).
  return twinRouter.createCaller(await createServerTrpcContext());
}

/** A query result, or the page's 404 when the twin / session / calibration is not in this org. */
export async function orNotFound<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}
