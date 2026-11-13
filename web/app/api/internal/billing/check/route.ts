import { cronAuthorized } from "@/lib/cron";
import { NextResponse } from "next/server";
import { checkAllBilling } from "@/lib/billing/billing";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel cron (daily, specs/billing.md rule 25): reads every billed org's recent Meteroid invoices and repairs what a
 * lost webhook or a failed workflow left behind (a missing copy or email, a payment not handled, an overdue renewal not
 * paused, an overdue upgrade not cancelled).
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const orgs = await checkAllBilling();
    return NextResponse.json({ ok: true, orgs });
  } catch (error) {
    console.error("[API:internal:billing:check] failed:", error);
    return NextResponse.json({ error: "Billing check failed" }, { status: 500 });
  }
}

export const POST = GET;
