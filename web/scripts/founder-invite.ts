/**
 * Generates a founder invite link (invite-only org creation).
 *
 * Usage: bun scripts/founder-invite.ts <email> [SALES|TECHNICAL_INTERVIEW]
 * The org type defaults to TECHNICAL_INTERVIEW.
 */
import { randomBytes } from "node:crypto";
import { db } from "../lib/db";
import { BASE_DOMAIN } from "../lib/base-domain";
import { isOrgType } from "../lib/org-type";

const email = process.argv[2];
const orgType = process.argv[3] ?? "TECHNICAL_INTERVIEW";
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isOrgType(orgType)) {
  console.error("Usage: bun scripts/founder-invite.ts <email> [SALES|TECHNICAL_INTERVIEW]");
  process.exit(1);
}

const token = randomBytes(24).toString("base64url");

if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
  console.error(`"${email}" is already registered — send them an invite from their dashboard instead.`);
  process.exit(1);
}

await db.founderInvite.create({ data: { token, email, orgType } });
console.log(`https://auth.${BASE_DOMAIN}/onboarding?t=${token}`);
process.exit(0);
