import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * Whether an org is paused (specs/billing.md rule 16: a Paid renewal is overdue), and what to tell whoever tried to
 * spend credits. Reads the app's copy only, so calls never wait on Meteroid. Kept apart from lib/billing/billing.ts so
 * lib/minutes.ts and session start can use it without importing billing.
 */
export async function pausedReason(orgId: string, who: "studio" | "learner", tx: Prisma.TransactionClient | typeof db = db) {
  const billing = await tx.orgBilling.findUnique({ where: { orgId }, select: { pausedAt: true } });
  if (!billing?.pausedAt) return null;
  return who === "studio"
    ? "Your organization's plan is paused because an invoice is overdue. Pay it to continue (Settings › Billing)."
    : "Practice is paused for this organization right now. Please ask your trainer.";
}
