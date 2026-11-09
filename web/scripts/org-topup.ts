/**
 * TrainerTwin adds practice minutes to an org's balance (until payments do it).
 *
 *   bun scripts/org-topup.ts --org olga --minutes 500 --note "Invoice 2026-114"
 *
 * Against a production database it also needs --production.
 */
import { db } from "@/lib/db";
import { topUpOrg } from "@/lib/minutes";
import { isRemoteDatabase } from "./razorpay-script-guard";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const slug = arg("org");
const minutes = Number(arg("minutes"));
const note = arg("note");
if (!slug || !Number.isInteger(minutes) || minutes < 1 || !note) throw new Error('usage: bun scripts/org-topup.ts --org <slug> --minutes <whole number> --note "<why>"');
if (isRemoteDatabase() && !args.includes("--production")) {
  throw new Error("refusing: this is a production database; add --production to write to it");
}

const org = await db.organization.findUnique({ where: { slug }, select: { id: true } });
if (!org) throw new Error(`No org "${slug}"`);
const { orgBalanceMinutes } = await topUpOrg({ orgId: org.id, minutes, note });
console.log(`${slug}: +${minutes} min · balance ${orgBalanceMinutes} min`);
await db.$disconnect();
