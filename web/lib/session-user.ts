import { headers } from "next/headers";
import { getSessionOrg } from "@/lib/org";
import { auth } from "@/lib/auth";
import type { SessionOrg } from "@/lib/org";

/** Org + signed-in user identity for a portal request. */
export async function resolveSessionUser(): Promise<{
  org: SessionOrg | null;
  user: { id: string; name: string; email: string } | null;
}> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { org: null, user: null };
  const org = await getSessionOrg();
  return {
    org,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
  };
}
