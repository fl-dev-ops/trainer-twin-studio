/**
 * Creates the founder account and invite link (invite-only org creation).
 *
 * Usage: bun scripts/founder-invite.ts <email>
 */
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { BASE_DOMAIN } from "../lib/base-domain";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: bun scripts/founder-invite.ts <email>");
  process.exit(1);
}

const token = randomBytes(24).toString("base64url");

if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
  console.error(`"${email}" is already registered — send them an invite from their dashboard instead.`);
  process.exit(1);
}

await db.$transaction(async (tx) => {
  await tx.user.create({ data: { id: randomUUID(), email, name: email.split("@")[0], emailVerified: false } });
  await tx.founderInvite.create({ data: { token, email } });
});
console.log(`https://auth.${BASE_DOMAIN}/onboarding?t=${token}`);
process.exit(0);
