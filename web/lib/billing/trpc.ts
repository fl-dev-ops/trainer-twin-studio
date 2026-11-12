import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { BillingError, billingOverview, buyPacks, saveBillingDetails } from "@/lib/billing/billing";
import { reconcilePaymentLink } from "@/lib/billing/razorpay";
import { db } from "@/lib/db";
import { MAX_PACKS } from "@/lib/billing/pricing";
import { studioProcedure, t } from "@/lib/trpc";

/**
 * The Billing page over /api/trpc (`billing`, specs/billing.md): the org's plan, billing details and invoices;
 * saving details and buying minute packs (staff move an org to a paid plan in Meteroid). Admin and team only (rule 5). PDFs download from
 * /api/billing/invoices/[id]/{pdf,receipt}.
 */

async function billingCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BillingError) {
      const code = error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : error.status === 502 ? "BAD_GATEWAY" : "BAD_REQUEST";
      throw new TRPCError({ code, message: error.message });
    }
    throw error;
  }
}

export const billingRouter = t.router({
  overview: studioProcedure.query(({ ctx }) => billingOverview(ctx.user.orgId)),

  /** Fields are checked in lib/billing/details.ts (one message per problem); anything else is refused there. */
  saveDetails: studioProcedure
    .input(z.object({ details: z.record(z.string(), z.unknown()) }))
    .mutation(({ ctx, input }) => billingCall(() => saveBillingDetails(ctx.user.orgId, input.details))),

  /**
   * Back from Razorpay's payment page (rule 28): asks Razorpay about the org's link now, so the payment shows without
   * waiting for its webhook. Razorpay's answer is the truth, not the page's URL.
   */
  confirmPayment: studioProcedure
    .input(z.object({ paymentLinkId: z.string().regex(/^plink_[A-Za-z0-9]+$/) }))
    .mutation(async ({ ctx, input }) => {
      const row = await db.billingInvoice.findFirst({ where: { orgId: ctx.user.orgId, paymentLinkId: input.paymentLinkId }, select: { paymentLinkId: true, status: true } });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      if (row.status !== "unpaid") return { status: row.status };
      return billingCall(async () => {
        try {
          return { status: (await reconcilePaymentLink(row))?.status ?? "pending" };
        } catch (error) {
          console.error(`[billing] confirming ${input.paymentLinkId}:`, error instanceof Error ? error.message : error);
          return { status: "pending" }; // the webhook and the daily check still bring it
        }
      });
    }),

  buyPacks: studioProcedure
    .input(z.object({ packs: z.number().int().min(1).max(MAX_PACKS), requestId: z.string().uuid() }))
    .mutation(({ ctx, input }) => billingCall(() => buyPacks(ctx.user.orgId, input.packs, input.requestId))),
});
