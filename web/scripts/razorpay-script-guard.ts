/**
 * The payment scripts write purchases that real money will settle: a production database needs --production and
 * live Razorpay keys, and live keys never point at a local database (a payment would credit the wrong place).
 */
export function checkScriptKeys(args: string[]) {
  const remote = /neon\.tech|amazonaws\.com/.test(process.env.DATABASE_URL ?? "");
  const live = (process.env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_live_");
  if (remote && !args.includes("--production")) throw new Error("refusing: this is a production database; add --production to write to it");
  if (remote && !live) throw new Error("refusing: a production database needs live Razorpay keys (rzp_live_…)");
  if (!remote && live) throw new Error("refusing: live Razorpay keys with a local database");
}
