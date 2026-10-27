import { requireStudioMember } from "@/lib/org";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { createServerTrpcContext } from "@/lib/trpc";

export { orNotFound } from "@/lib/twin/server";

/** The role-play tRPC router for a server component, as the signed-in studio member (others are sent away). */
export async function roleplayServer() {
  await requireStudioMember();
  return roleplayRouter.createCaller(await createServerTrpcContext());
}
