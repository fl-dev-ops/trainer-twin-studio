import { headers } from "next/headers";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { currentMembership, isStudioRole } from "@/lib/org";


function familyOrigin(name: string) {
  // Preserve the port so local proxies (portless :NNNN) keep working.
  return headers().then((h) => {
    const host = h.get("host") ?? "";
    const port = host.includes(":") ? `:${host.split(":")[1]}` : "";
    return `https://${name}.${BASE_DOMAIN}${port}`;
  });
}

/**
 * Where should this signed-in user land?
 * Trainers (a studio role in any org) -> dash host, learners -> their current org's host (pickMembership),
 * null -> not signed in. No enabled membership -> "/auth/no-org".
 */
export async function resolveHome(): Promise<string | null> {
  const current = await currentMembership(await headers());
  if (!current) return null;
  if (!current.member) return "/auth/no-org";
  // pickMembership prefers studio memberships, so a studio role anywhere lands on the dash.
  if (isStudioRole(current.member.role)) return `${await familyOrigin("dash")}/`;
  return `${await familyOrigin(current.member.organization.slug)}/`;
}
