/**
 * Charges an org's credits for admin/team sessions from before Meteroid billing (they were free then, so they have
 * no usage row): writes one org_usage row per session (its length, start to end), marks the session chargesOrg, sends
 * the usage to Meteroid and waits until it's counted (lib/org-credits.ts). Safe to run again: a session already
 * charged is skipped. Used once, for the phase 1 release (olga's 4 calibrations).
 *
 *   bun scripts/charge-past-sessions.ts --org olga --sessions <id>,<id>,…        [--production]
 */
import { db } from "@/lib/db";
import { orgCredits, refreshOrgCredits, sendOrgUsage } from "@/lib/org-credits";
import { STUDIO_ROLES } from "@/lib/org";
import { isRemoteDatabase } from "./razorpay-script-guard";

const USAGE = "usage: bun scripts/charge-past-sessions.ts --org <slug> --sessions <id>,<id>,… [--production]";
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const slug = arg("org");
const ids = (arg("sessions") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
if (!slug || !ids.length) throw new Error(USAGE);
const productionKey = (process.env.METEROID_API_KEY ?? "").startsWith("pv_prod_");
if (isRemoteDatabase() && !args.includes("--production")) throw new Error("refusing: this is a production database; add --production to write to it");
if (isRemoteDatabase() !== productionKey) throw new Error("refusing: the Meteroid key and the database must both be production, or both not");

const org = await db.organization.findUniqueOrThrow({ where: { slug }, select: { id: true, billing: { select: { meteroidCustomerId: true } } } });
if (!org.billing) throw new Error(`${slug} isn't billed by Meteroid yet (scripts/meteroid-link-org.ts)`);
let charged = 0;
for (const id of ids) {
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: org.id },
    select: { id: true, userId: true, startedAt: true, endedAt: true, user: { select: { email: true } } },
  });
  if (!session?.startedAt || !session.endedAt) throw new Error(`${id}: not a finished session of ${slug}`);
  const member = await db.member.findFirst({ where: { organizationId: org.id, userId: session.userId, role: { in: [...STUDIO_ROLES] } }, select: { id: true } });
  if (!member) throw new Error(`${id}: not an admin/team session (learners' sessions use their own minutes)`);
  if (await db.minuteLedger.findFirst({ where: { sessionId: id }, select: { id: true } })) {
    console.log(`${id}: already charged, skipped`);
    continue;
  }
  const seconds = Math.max(0, Math.floor((session.endedAt.getTime() - session.startedAt.getTime()) / 1000));
  await db.$transaction([
    db.minuteLedger.create({ data: { orgId: org.id, email: session.user.email.toLowerCase(), userId: session.userId, type: "org_usage", seconds: -seconds, sessionId: id, note: "Charged at the phase 1 release (session from before billing)" } }),
    db.interviewSession.update({ where: { id }, data: { chargesOrg: true } }),
  ]);
  charged += seconds;
  console.log(`${id}: charged ${Math.floor(seconds / 60)}m ${seconds % 60}s`);
}
const sentAt = await sendOrgUsage(org.id);
for (let check = 0; check < 10 && !(await refreshOrgCredits(org.id, sentAt)).counted; check++) await new Promise((resolve) => setTimeout(resolve, 2000));
console.log(`${slug}: charged ${(charged / 60).toFixed(1)} min · org credits now ${(await orgCredits(org.id)).minutes} min`);
await db.$disconnect();
