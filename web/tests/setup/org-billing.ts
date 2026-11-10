import { http, HttpResponse } from "msw";

/** Small Meteroid onboarding fixture; records wire payloads and allows endpoint-specific overrides via server.use. */
export function orgBillingService() {
  const requests: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const grants: { key: string | null; body: unknown }[] = [];
  const handlers = [http.all("https://meteroid.test/api/v1/*", async ({ request }) => {
    const path = new URL(request.url).pathname.replace("/api/v1", "");
    const method = request.method;
    const body = method === "GET" || method === "DELETE" ? null : await request.json();
    requests.push({ method, path, body, key: request.headers.get("idempotency-key") });
    if (method === "GET" && path.startsWith("/customers/")) return HttpResponse.json({}, { status: 404 });
    if (method === "POST" && path === "/customers") return HttpResponse.json({ id: "customer-onboarding" });
    if (method === "POST" && path.endsWith("/credit-grants")) {
      const key = request.headers.get("idempotency-key");
      if (!grants.some((grant) => grant.key === key)) grants.push({ key, body });
      return HttpResponse.json({ id: "trial-grant" });
    }
    if (method === "GET" && path === "/metrics") return HttpResponse.json({ data: [{ id: "metric-voice", code: "voice_minutes" }] });
    if (method === "GET" && path === "/subscriptions") return HttpResponse.json({ data: [] });
    if (method === "GET" && path === "/plans") return HttpResponse.json({ data: [{ id: "plan-credits", name: "Credits" }] });
    if (method === "GET" && path === "/plans/plan-credits") return HttpResponse.json({ price_components: [{ fee: { metric_id: "metric-voice" } }] });
    if (method === "POST" && path === "/subscriptions") return HttpResponse.json({ subscription: { id: "subscription-credits" } });
    if (method === "POST" && path.endsWith("/cancel")) return HttpResponse.json({});
    if (method === "PATCH" && path.startsWith("/customers/")) return HttpResponse.json({});
    if (method === "DELETE" && path.startsWith("/customers/")) return HttpResponse.json({});
    throw new Error(`Unexpected billing request: ${method} ${path}`);
  })];
  return { requests, grants, handlers };
}
