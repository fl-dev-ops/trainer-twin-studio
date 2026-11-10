/** Local Meteroid for the browser server. The seeded cache is its wallet; no real billing requests leave this process. */
import "./use-test-db";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { db } from "@/lib/db";
import type { CreditGrant } from "@/lib/meteroid";

const granted = new Set<string>();
const ingested = new Set<string>();
createServer(async (request, response) => {
  const url = new URL(request.url!, "http://127.0.0.1:3998");
  const customer = url.pathname.match(/\/customers\/([^/]+)\//)?.[1];
  const billing = customer ? await db.orgBilling.findUnique({ where: { meteroidCustomerId: customer } }) : null;
  response.setHeader("content-type", "application/json");
  if (request.headers.authorization !== "Bearer e2e-meteroid") { response.writeHead(401).end("{}"); return; }
  if (request.method === "POST" && url.pathname === "/api/v1/events/ingest") {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { events: { event_id: string; customer_id: string; properties: { minutes: string } }[] };
    for (const event of body.events) {
      if (ingested.has(event.event_id)) continue;
      const minutes = Number(event.properties.minutes);
      // shortcut: browser specs only give whole minutes, extend the fake wallet before testing fractional calls.
      assert(Number.isInteger(minutes) && minutes > 0);
      await db.orgBilling.update({ where: { meteroidCustomerId: event.customer_id }, data: { balanceMinutes: { decrement: minutes }, balanceAsOf: new Date() } });
      ingested.add(event.event_id);
    }
    response.end("{}"); return;
  }
  if (!billing) { response.writeHead(404).end("{}"); return; }
  if (request.method === "GET" && url.pathname.endsWith("/wallets/check")) {
    response.end(JSON.stringify({ balance: billing.balanceMinutes, as_of: new Date().toISOString() })); return;
  }
  if (request.method === "GET" && url.pathname.endsWith("/credit-grants")) {
    response.end(JSON.stringify({ data: (billing.grants as CreditGrant[]).map((g) => ({ id: g.id, amount: g.minutes, reason: g.reason, expires_at: g.expiresAt, created_at: g.createdAt, status: g.status, credit_unit: "MINS" })) })); return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/credit-grants")) {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { amount: number; reason: string; expires_at: string };
    const key = String(request.headers["idempotency-key"]);
    if (!granted.has(key)) {
      granted.add(key);
      const grant = { id: key, minutes: body.amount, reason: body.reason, expiresAt: body.expires_at, createdAt: new Date().toISOString(), status: "ACTIVE" };
      await db.orgBilling.update({ where: { orgId: billing.orgId }, data: { balanceMinutes: { increment: body.amount }, grants: [...billing.grants as CreditGrant[], grant] } });
    }
    response.end("{}"); return;
  }
  response.writeHead(500).end(JSON.stringify({ error: `Unexpected Meteroid request: ${request.method} ${url.pathname}` }));
}).listen(3998, "127.0.0.1");
