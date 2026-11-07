/**
 * Sets one person's org role (creating the membership when absent, as `team` is below), printing before and after.
 * Idempotent. Run with the env file you intend to touch (local or prod):
 *   bun --env-file=.env.prod scripts/set-member-role.ts <email> <admin|team|user> <orgSlug>
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter });

const [email, role, orgSlug] = process.argv.slice(2);
const ROLES = ["admin", "team", "user"];
if (!email || !ROLES.includes(role) || !orgSlug) {
  console.error("Usage: bun --env-file=<env> scripts/set-member-role.ts <email> <admin|team|user> <orgSlug>");
  process.exit(1);
}
const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true, name: true } });
if (!org) throw new Error(`Org ${orgSlug} not found`);

let member = await db.member.findFirst({
  where: { user: { email }, organizationId: org.id },
  select: { id: true, role: true, disabledAt: true, userId: true, user: { select: { name: true, email: true } } },
});
if (member) {
  console.log("Before:", member);
} else {
  const user = await db.user.findFirst({ where: { email }, select: { id: true, name: true, email: true } });
  if (!user) throw new Error(`No user with email ${email} (they must have signed in once first)`);
  member = await db.member.create({
    data: { id: randomUUID(), organizationId: org.id, userId: user.id, role, createdAt: new Date() },
    select: { id: true, role: true, disabledAt: true, userId: true, user: { select: { name: true, email: true } } },
  });
  console.log(`Created membership: ${email} joined ${org.name} as ${role}.`);
  await db.$disconnect();
  process.exit(0);
}
if (member.role === role) {
  console.log("Already in place, nothing to do.");
} else {
  const adminCount = await db.member.count({ where: { organizationId: org.id, role: "admin" } });
  if (role === "admin" && adminCount > 0) throw new Error("That org already has an admin (one-admin rule)");
  await db.member.update({ where: { id: member.id }, data: { role } });
  console.log(`After: ${email} is now ${role} in ${org.name}. Ask them to sign out and back in.`);
}
await db.$disconnect();
