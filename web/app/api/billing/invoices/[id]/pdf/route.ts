import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { BillingError, invoicePdfFor, orgInvoice } from "@/lib/billing/billing";
import { currentMembership, isStudioRole } from "@/lib/org";

/** An invoice's PDF (drawn by the app from Meteroid's invoice, specs/billing.md rule 22), for the org's admin and team (Settings › Billing; specs/billing.md rule 5). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const current = await currentMembership(await headers());
  if (!current) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!current.member || !isStudioRole(current.member.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const orgId = current.member.organization.id;
  try {
    const [row, pdf] = await Promise.all([orgInvoice(orgId, id), invoicePdfFor(orgId, id)]);
    return new NextResponse(new Uint8Array(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${row.number}.pdf"`, "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof BillingError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
