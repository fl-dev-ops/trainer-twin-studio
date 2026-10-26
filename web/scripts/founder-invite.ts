/**
 * Generates a founder invite link (invite-only org creation).
 *
 * Usage: bun scripts/founder-invite.ts <email|--any> [SALES|TECHNICAL_INTERVIEW]
 * --any creates an invite that any signed-in account can accept.
 * The org type defaults to TECHNICAL_INTERVIEW.
 */
import { randomBytes } from "node:crypto";
import { db } from "../lib/db";
import { BASE_DOMAIN } from "../lib/base-domain";
import { isOrgType } from "../lib/org-type";

const target = process.argv[2];
const email = target === "--any" ? null : target;
const orgType = process.argv[3] ?? "TECHNICAL_INTERVIEW";
if (!target || (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || !isOrgType(orgType)) {
  console.error("Usage: bun scripts/founder-invite.ts <email|--any> [SALES|TECHNICAL_INTERVIEW]");
  process.exit(1);
}

const token = randomBytes(24).toString("base64url");

if (email && await db.user.findUnique({ where: { email }, select: { id: true } })) {
  console.error(`"${email}" is already registered — send them an invite from their dashboard instead.`);
  process.exit(1);
}

await db.founderInvite.create({ data: { token, email, orgType } });
console.log(`https://auth.${BASE_DOMAIN}/onboarding?t=${token}`);
process.exit(0);
