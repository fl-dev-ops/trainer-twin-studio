/**
 * The payment scripts write purchases that real money will settle: a production database needs --production and
 * live Razorpay keys, and live keys never point at a local database (a payment would credit the wrong place).
 */
/** Anything but this machine's database counts as production (not only the hosts we use today). */
export function isRemoteDatabase(url = process.env.DATABASE_URL ?? "") {
  const host = URL.canParse(url) ? new URL(url).hostname : "";
  return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

export function checkScriptKeys(args: string[]) {
  const remote = isRemoteDatabase();
  const live = (process.env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_live_");
  if (remote && !args.includes("--production")) throw new Error("refusing: this is a production database; add --production to write to it");
  if (remote && !live) throw new Error("refusing: a production database needs live Razorpay keys (rzp_live_…)");
  if (!remote && live) throw new Error("refusing: live Razorpay keys with a local database");
}
