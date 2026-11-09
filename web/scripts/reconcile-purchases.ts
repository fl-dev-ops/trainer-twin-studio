/**
 * Catches up credit purchases whose Razorpay webhook never arrived: paid ones get their credits, refunded ones give
 * them back (lib/credit-purchases.ts reconcilePurchases; each still happens once). Reports by default.
 *
 *   bun scripts/reconcile-purchases.ts                       report: what's missing
 *   bun scripts/reconcile-purchases.ts --apply               apply it
 *   --older-than <hours>  unpaid purchases older than this (default 1; younger ones may be mid-checkout)
 *   --refund-days <days>  check refunds of purchases paid in the last N days (default 30)
 *
 * Against a production database it also needs --production, and live keys. Exits 1 when anything errored.
 */
import { reconcilePurchases } from "@/lib/credit-purchases";
import { db } from "@/lib/db";
import { checkScriptKeys } from "./razorpay-script-guard";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const olderThanHours = Number(arg("older-than") ?? 1);
const refundDays = Number(arg("refund-days") ?? 30);
if (!(olderThanHours >= 0) || !(refundDays > 0)) throw new Error("usage: bun scripts/reconcile-purchases.ts [--apply] [--older-than <hours>] [--refund-days <days>]");
const apply = args.includes("--apply");
if (apply) checkScriptKeys(args);

const lines = await reconcilePurchases({ olderThanHours, refundDays, apply });
console.log(`${apply ? "APPLY" : "REPORT"} · ${lines.length} purchase event(s) to look at`);
for (const line of lines) console.log(`  ${line.action.padEnd(12)} ${line.org} · ${line.razorpayId ?? line.purchase} · ${line.detail}`);
await db.$disconnect();
if (lines.some((line) => line.action === "error")) process.exit(1);
