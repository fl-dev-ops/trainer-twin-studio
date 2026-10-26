import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import { isStudioRole } from "@/lib/org";
import { createServerTrpcContext } from "@/lib/trpc";
import { twinRouter } from "@/lib/twin/trpc";

/** The twin tRPC router for a server component, as the signed-in studio member (others are sent away). */
export async function twinServer() {
  const ctx = await createServerTrpcContext();
  if (!ctx.user || !isStudioRole(ctx.user.role)) redirect("/auth/no-org");
  return twinRouter.createCaller(ctx);
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
