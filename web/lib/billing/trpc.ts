import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { BillingError, billingOverview, buyPacks, requestUpgrade, saveBillingDetails } from "@/lib/billing/billing";
import { MAX_PACKS } from "@/lib/billing/pricing";
import { studioProcedure, t } from "@/lib/trpc";

/**
 * Settings › Billing over /api/trpc (`billing`, specs/billing.md): the org's plan, billing details and invoices;
 * saving details, upgrading to Paid and buying minute packs. Admin and team only (rule 5). PDFs download from
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

  upgrade: studioProcedure.mutation(({ ctx }) => billingCall(() => requestUpgrade(ctx.user.orgId))),

  buyPacks: studioProcedure
    .input(z.object({ packs: z.number().int().min(1).max(MAX_PACKS), requestId: z.string().uuid() }))
    .mutation(({ ctx, input }) => billingCall(() => buyPacks(ctx.user.orgId, input.packs, input.requestId))),
});
