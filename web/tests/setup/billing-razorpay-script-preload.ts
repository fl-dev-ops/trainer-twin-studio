// Child-process fee-report tests retain the real local DB; only Razorpay's HTTP responses are replaced.
const fixtures = JSON.parse(process.env.BILLING_REPORT_RAZORPAY_FIXTURES ?? "{}") as Record<string, unknown>;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.razorpay.com") throw new Error(`Unexpected script network request: ${url}`);
  const path = `${url.pathname}${url.search}`;
  console.error(`[fake Razorpay] ${path}`);
  if (!(path in fixtures)) return Response.json({ error: { description: `No fake for ${path}` } }, { status: 503 });
  return Response.json(fixtures[path]);
}) as typeof fetch;
