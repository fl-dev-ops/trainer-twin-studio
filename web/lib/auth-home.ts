import { headers } from "next/headers";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const TRAINER_ROLES = new Set(["owner", "admin"]);

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
 * Trainers -> dash host, learners -> their org host, null -> not signed in.
 * Members with no organization -> "/auth/no-org".
 */
export async function resolveHome(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const memberships = await db.member.findMany({
    where: { userId: session.user.id },
    select: { role: true, organization: { select: { slug: true } } },
  });

  if (memberships.length === 0) return "/auth/no-org";

  const isTrainer = memberships.some((m) =>
    m.role.split(",").some((r) => TRAINER_ROLES.has(r.trim())),
  );
  if (isTrainer) return `${await familyOrigin("dash")}/`;
  return `${await familyOrigin(memberships[0].organization.slug)}/`;
}
