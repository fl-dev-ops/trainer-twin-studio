// A script subprocess cannot use the parent flow's MSW. Fail closed: no request ever reaches real Razorpay.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.razorpay.com") throw new Error(`Unexpected script request: ${url}`);
  return Response.json({ error: { description: "fake subprocess Razorpay outage" } }, { status: 500 });
}) as typeof fetch;
