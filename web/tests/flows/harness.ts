import { meteroidHandlers } from "../setup/meteroid";
import { createHmac } from "node:crypto";
import { spyOn } from "bun:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as nextServer from "next/server";

/**
 * Flow tests run the app's real code and database; only the outside services are fake, answered at the network by
 * MSW: Meteroid, Razorpay, Resend (emails), LiveKit (rooms, agent dispatch) and the chat runtime. Every request is recorded, and
 * one nobody answers is a failure (`unexpected`), so a flow can't quietly reach a real service.
 */

export type Email = { to: string[]; subject: string; html: string; text?: string };
type Json = Record<string, unknown>;

const LIVEKIT_REPLIES: Record<string, Json> = {
  ListRooms: { rooms: [] },
  CreateRoom: { name: "room", sid: "RM_test" },
  UpdateRoomMetadata: { name: "room" },
  ListDispatch: { agentDispatches: [] },
  CreateDispatch: { id: "AD_test", agentName: "agent", room: "room" },
  DeleteDispatch: { id: "AD_test" },
  ListEgress: { items: [] },
  DeleteRoom: {},
};

export function outsideServices() {
  const emails: Email[] = [];
  const paymentLinks: Json[] = [];
  const invoices = new Map<string, Json>();
  const paymentLinkStates = new Map<string, Json | HttpResponse>();
  const refunds = new Map<string, Json[]>();
  const razorpayReads: string[] = [];
  const livekit: string[] = [];
  const chatSessions: string[] = [];
  const unexpected: string[] = [];
  let next = 0;

  const server = setupServer(
    ...meteroidHandlers,
    http.post("https://api.resend.com/emails", async ({ request }) => {
      const body = (await request.json()) as { to: string | string[]; subject: string; html: string; text?: string };
      emails.push({ to: [body.to].flat(), subject: body.subject, html: body.html, text: body.text });
      return HttpResponse.json({ id: `email_${++next}` });
    }),
    http.post("https://api.razorpay.com/v1/payment_links", async ({ request }) => {
      const body = (await request.json()) as Json;
      const id = `plink_flow_${body.reference_id}`;
      paymentLinks.push({ id, ...body });
      return HttpResponse.json({ id, short_url: `https://rzp.io/test/${id}`, amount: body.amount, currency: body.currency, status: "created" });
    }),
    http.get("https://api.razorpay.com/v1/payment_links/:id", ({ params }) => {
      razorpayReads.push(`/payment_links/${params.id}`);
      const link = paymentLinkStates.get(String(params.id));
      return link instanceof HttpResponse ? link : link ? HttpResponse.json(link) : HttpResponse.json({ error: { description: "The id provided does not exist" } }, { status: 400 });
    }),
    http.get("https://api.razorpay.com/v1/payments/:id/refunds", ({ params }) => {
      razorpayReads.push(`/payments/${params.id}/refunds`);
      return HttpResponse.json({ items: refunds.get(String(params.id)) ?? [] });
    }),
    http.get("https://api.razorpay.com/v1/invoices/:id", ({ params }) => {
      razorpayReads.push(`/invoices/${params.id}`);
      const invoice = invoices.get(String(params.id));
      return invoice ? HttpResponse.json(invoice) : HttpResponse.json({ error: { description: "The id provided does not exist" } }, { status: 400 });
    }),
    http.post("https://livekit.test/twirp/:service/:method", ({ params }) => {
      const method = String(params.method);
      livekit.push(method);
      return HttpResponse.json(LIVEKIT_REPLIES[method] ?? {});
    }),
    http.post("http://chat.test/internal/sessions", async ({ request }) => {
      chatSessions.push(String(((await request.json()) as Json).sessionId));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  server.events.on("request:unhandled", ({ request }) => {
    unexpected.push(`${request.method} ${request.url}`);
  });
  // next/server's after() needs a live request; flows skip the background work (reports, LLM calls).
  let after: { mockRestore(): void } | null = null;

  return {
    emails, paymentLinks, invoices, paymentLinkStates, refunds, razorpayReads, livekit, chatSessions, unexpected,
    use: server.use.bind(server),
    resetHandlers: server.resetHandlers.bind(server),
    start() {
      server.listen({ onUnhandledRequest: "error" });
      after = spyOn(nextServer, "after").mockImplementation(() => {});
    },
    stop() {
      server.close();
      after?.mockRestore();
    },
    /** Clears what was recorded between tests (not the Razorpay registries set up for them). */
    reset() {
      emails.length = 0; paymentLinks.length = 0; razorpayReads.length = 0; livekit.length = 0; chatSessions.length = 0; unexpected.length = 0;
    },
  };
}

/** Razorpay's webhook, signed like Razorpay signs it, through the real route. */
export async function razorpayWebhook(event: string, payload: Json) {
  const { POST } = await import("@/app/api/razorpay/webhook/route");
  const raw = JSON.stringify({ event, payload });
  const signature = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!).update(raw).digest("hex");
  const response = await POST(new Request("http://dash.test/api/razorpay/webhook", { method: "POST", body: raw, headers: { "x-razorpay-signature": signature } }));
  return { status: response.status, body: (await response.json()) as Json };
}

/** The voice agent's end-of-call webhook (transcript and final status), through the real route. */
export async function agentWebhook(sessionId: string, status: "COMPLETED" | "ABANDONED" = "COMPLETED", transcript = [{ role: "assistant", text: "Hello" }, { role: "user", text: "Hi" }]) {
  const { POST } = await import("@/app/api/sessions/webhook/route");
  const response = await POST(new Request("http://dash.test/api/sessions/webhook", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, status, transcript }),
    headers: { authorization: `Bearer ${process.env.COPILOT_SERVICE_SECRET}`, "content-type": "application/json" },
  }) as never);
  return { status: response.status, body: (await response.json()) as Json };
}

/** The personal practice code in a role-play email's link (…/s/<code>). */
export function practiceCode(email: Email) {
  const code = email.html.match(/\/s\/([A-Za-z0-9_-]+)/)?.[1];
  if (!code) throw new Error(`no practice link in "${email.subject}"`);
  return code;
}
