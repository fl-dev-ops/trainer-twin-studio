/**
 * The browser tests' data, made fresh on every run in the test database (bun e2e/seed.ts; the setup project runs it):
 * the "E2E Academy" org with 500 credits, an admin, a learner with a role play assigned (30 credits), a learner who
 * has used all theirs, and 22 more learners with credits (for paging). Writes e2e/.state/seed.json.
 */
import "./use-test-db";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/lib/db";
import { inviteToRoleplay } from "@/lib/invite/roleplay";
import { giveStartingMinutes, recordSessionUsage, topUpOrg } from "@/lib/minutes";

export const PASSWORD = "e2e-password";
const ORG = { id: "e2e-org", slug: "e2e", name: "E2E Academy" };
const person = (key: string, name: string) => ({ id: `e2e-${key}`, name, email: `e2e-${key}@example.com` });
const admin = person("admin", "Ada Admin");
const learner = person("learner", "Lena Learner");
const broke = person("broke", "Brook Broke");
const more = Array.from({ length: 22 }, (_, i) => person(`learner-${String(i + 1).padStart(2, "0")}`, `Learner ${String(i + 1).padStart(2, "0")}`));
const everyone = [admin, learner, broke, ...more];

// Start clean: everything the last run made, children first (not all of it cascades from the org).
const where = { orgId: ORG.id };
await db.minuteLedger.deleteMany({ where });
await db.interviewSession.deleteMany({ where });
await db.rolePlayAssignment.deleteMany({ where });
await db.deployment.deleteMany({ where });
await db.agent.deleteMany({ where });
await db.persona.deleteMany({ where });
await db.organization.deleteMany({ where: { id: ORG.id } });
await db.user.deleteMany({ where: { id: { in: everyone.map((p) => p.id) } } });

await db.organization.create({ data: { ...ORG, createdAt: new Date() } });
const hash = await hashPassword(PASSWORD);
for (const p of everyone) {
  await db.user.create({ data: { ...p, emailVerified: true } });
  await db.account.create({ data: { id: `${p.id}-credential`, accountId: p.id, providerId: "credential", userId: p.id, password: hash } });
  await db.member.create({ data: { id: `${p.id}-member`, organizationId: ORG.id, userId: p.id, role: p === admin ? "admin" : "user", createdAt: new Date() } });
}
await topUpOrg({ orgId: ORG.id, minutes: 500, note: "Starting balance" });

// A link made by the payment-link script; browser tests deliver its signed payment/refund webhooks.
const purchase = await db.creditPurchase.create({
  data: { orgId: ORG.id, kind: "payment_link", razorpayId: "plink_e2e_credits", currency: "INR", credits: 100, amount: 80000 },
});

const persona = await db.persona.create({ data: { orgId: ORG.id, slug: "e2e-trainer", name: "E2E Trainer", data: {}, isOwn: true } });
const roleplay = await db.agent.create({
  data: { id: "e2e-roleplay", orgId: ORG.id, personaId: persona.id, kind: "ROLEPLAY", slug: "e2e-pitch", name: "Pitch practice", data: { objective: "Pitch the product in two minutes." } },
});
const by = { id: admin.id, name: admin.name };
await inviteToRoleplay({ org: ORG, by, agent: roleplay, emails: [learner.email], startingMinutes: 30 });
await inviteToRoleplay({ org: ORG, by, agent: roleplay, emails: [broke.email], startingMinutes: 1 });
await giveStartingMinutes({ orgId: ORG.id, emails: more.map((p) => p.email), minutes: 10, actorUserId: admin.id });

// The broke learner's one minute, spent on a call that ended.
const brokeAssignment = await db.rolePlayAssignment.findFirstOrThrow({ where: { orgId: ORG.id, recipientEmail: broke.email } });
const spent = await db.interviewSession.create({
  data: {
    orgId: ORG.id, userId: broke.id, agentId: roleplay.id, assignmentId: brokeAssignment.id, shareCode: "e2e-broke-session",
    personaSlug: persona.slug, personaVersion: 1, agentSlug: roleplay.slug, agentVersion: 1, status: "completed",
    allowedSeconds: 60, startedAt: new Date(Date.now() - 120_000), endedAt: new Date(Date.now() - 30_000),
  },
});
await recordSessionUsage(spent.id);

const codes = Object.fromEntries((await db.rolePlayAssignment.findMany({ where: { orgId: ORG.id }, select: { recipientEmail: true, shareCode: true } }))
  .map((row) => [row.recipientEmail, row.shareCode]));
mkdirSync(new URL("./.state", import.meta.url), { recursive: true });
writeFileSync(new URL("./.state/seed.json", import.meta.url), JSON.stringify({
  org: ORG, password: PASSWORD, admin, learner, broke, more,
  purchase: { id: purchase.id, razorpayId: purchase.razorpayId, paymentId: `pay_e2e_${purchase.id}`, refundId: `rfnd_e2e_${purchase.id}` },
  codes: { learner: codes[learner.email], broke: codes[broke.email] },
}, null, 2));
console.log(`seeded ${ORG.slug}: ${everyone.length} people`);
await db.$disconnect();
