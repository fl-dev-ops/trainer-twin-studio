import type { TaxLine } from "@/lib/billing/details";

/**
 * Minute pack prices (specs/billing.md rule 4), tax included, in USD cents. Plan prices live in Meteroid (each org's own plan). Meteroid's top-ups (minute packs) are
 * priced before tax, so a pack's price is turned into a net unit price that lands exactly on the gross total.
 */

export const PACK_CREDITS = 100;
export const PACK_CENTS = 2_500;
export const MAX_PACKS = 10;
/** Credits from a pack expire this long after the pack's invoice is issued. */
export const PACK_VALID_DAYS = 365;
export const CURRENCY = "USD";

/** Meteroid rounds each tax half away from zero, on its own (one line, one tax each). */
const taxOn = (netCents: number, bp: number) => Math.floor((netCents * bp + 5_000) / 10_000);

export function totalWithTax(netCents: number, taxes: TaxLine[]) {
  return netCents + taxes.reduce((sum, tax) => sum + taxOn(netCents, tax.bp), 0);
}

/**
 * The before-tax price of `packs` minute packs so the invoice comes to $25 × packs with these taxes: the net amount in
 * cents, and the unit price per credit Meteroid is given (8 decimals; credits × unit price rounds back to the net).
 * CGST and SGST are rounded on their own, so some totals can't be reached exactly: then the closest one below (1 cent
 * less, never more).
 */
export function packPrice(packs: number, taxes: TaxLine[]) {
  if (!Number.isInteger(packs) || packs < 1 || packs > MAX_PACKS) throw new Error(`Buy 1 to ${MAX_PACKS} packs`);
  const credits = packs * PACK_CREDITS;
  const priceCents = packs * PACK_CENTS;
  const rate = taxes.reduce((sum, tax) => sum + tax.bp, 0);
  const guess = Math.floor((priceCents * 10_000) / (10_000 + rate));
  let best: { netCents: number; grossCents: number } | null = null;
  for (let netCents = guess - 5; netCents <= guess + 5; netCents++) {
    const grossCents = totalWithTax(netCents, taxes);
    if (grossCents <= priceCents && (!best || grossCents > best.grossCents)) best = { netCents, grossCents };
  }
  if (!best || priceCents - best.grossCents > 1) throw new Error(`No net price makes ${packs} packs ${priceCents} cents with these taxes`);
  const unitPrice = (best.netCents / 100 / credits).toFixed(8);
  if (Math.round(Number(unitPrice) * credits * 100) !== best.netCents) throw new Error(`Unit price ${unitPrice} doesn't round back to ${best.netCents} cents`);
  return { credits, priceCents, grossCents: best.grossCents, netCents: best.netCents, taxCents: best.grossCents - best.netCents, unitPrice };
}

/** "$300.00" from cents (or "₹25,000.00" for an invoice in another currency). */
export function formatMoney(cents: number, currency: string = CURRENCY) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency }).format(cents / 100);
}

export const formatUsd = (cents: number) => formatMoney(cents, CURRENCY);
