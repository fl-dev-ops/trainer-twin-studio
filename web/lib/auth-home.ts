import { headers } from "next/headers";
import { familyOrigin } from "@/lib/base-domain";
import { currentMembership, isStudioRole } from "@/lib/org";


/**
 * Where should this signed-in user land?
 * Trainers (a studio role in any org) -> dash host, learners -> their current org's host (pickMembership),
 * null -> not signed in. No enabled membership -> "/auth/no-org".
 */
export async function resolveHome(): Promise<string | null> {
  const current = await currentMembership(await headers());
  if (!current) return null;
  if (!current.member) return "/auth/no-org";
  const host = (await headers()).get("host") ?? "";
  // pickMembership prefers studio memberships, so a studio role anywhere lands on the dash.
  if (isStudioRole(current.member.role)) return `${familyOrigin(host, "dash")}/`;
  return `${familyOrigin(host, current.member.organization.slug)}/`;
}
