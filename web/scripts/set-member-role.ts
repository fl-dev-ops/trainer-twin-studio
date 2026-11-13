/**
 * Moves someone between team and learner in one org (specs/people.md rule 19), through lib/members.ts changeMemberRole:
 * the org's people lock, and becoming team removes their learner assignments. The admin never changes, nobody becomes
 * admin, and someone not in the org is added from Settings first. Run with the env file you intend to touch:
 *   bun --env-file=.env.prod scripts/set-member-role.ts <email> <team|user> <orgSlug>
 */
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { changeMemberRole } from "@/lib/members";

const [email, role, orgSlug] = process.argv.slice(2);
if (!email || (role !== "team" && role !== "user") || !orgSlug) {
  console.error("Usage: bun --env-file=<env> scripts/set-member-role.ts <email> <team|user> <orgSlug>");
  process.exit(1);
}
const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true, name: true } });
if (!org) {
  console.error(`No org ${orgSlug}`);
  process.exit(1);
}
try {
  const { before, after } = await changeMemberRole({ orgId: org.id, email, role });
  console.log(before === after ? `${email} is already ${after} in ${org.name}; nothing to do.` : `${email}: ${before} → ${after} in ${org.name}.`);
} catch (error) {
  if (!(error instanceof AppError)) throw error;
  console.error(error.code === "not_found" ? `${email} isn't in ${org.name}; add them from Settings first.` : error.message);
  process.exitCode = 1;
}
await db.$disconnect();
