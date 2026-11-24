import assert from "node:assert/strict";

const orgId = "voice-org-test";
const sessionId = "voice-session-test";
const token = "test-runtime-token";
const secret = "test-chat-secret";
const turns = new Map([
  ["[OPENING] Generate the session opening.", ["Hi, ", "let's practise."]],
  ["I would start by asking about your goals.", ["Go ", "on."]],
]);

process.env.COPILOT_SERVICE_SECRET = secret;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/copilot/studio") {
      assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
      assert.equal(request.headers.get("x-trainertwin-org-id"), orgId);
      const body = await request.json();
      if (body.action === "authorizeRuntimeSession") {
        assert.equal(body.sessionId, sessionId);
        assert.equal(body.token, token);
        return Response.json({ valid: true, anonymous: false });
      }
      assert.equal(body.action, "recordTurnEvidence");
      return Response.json({ ok: true });
    }
    if (path !== "/v1/chat/completions") return new Response(null, { status: 404 });
    const body = await request.clone().json();
    assert.equal(body.model, "trainertwin-runtime");
    assert.equal(body.stream, true);
    return complete(request, {
      from(address) {
        assert.equal(address, sessionId);
        return {
          cancel: async () => {},
          async send(message, { auth }) {
            assert.equal(typeof message, "string");
            assert.equal(auth?.attributes?.sessionId, sessionId);
            assert.equal(auth?.principalId, orgId);
            const reply = turns.get(String(message));
            assert.ok(reply, "The bridge must deliver the expected opening or latest learner message");
            return {
              deliveryId: "qa-delivery",
              async *stream() {
                yield { type: "turn.started", data: { turnId: "qa-turn" } };
                for (const delta of reply) {
                  yield { type: "content.delta", data: { partId: "qa-text", kind: "text", delta } };
                }
                yield { type: "delivery.settled", data: { deliveryId: "qa-delivery", outcome: "completed" } };
              },
            };
          },
        } as ReturnType<Parameters<typeof complete>[1]["from"]>;
      },
      waitUntil(promise) {
        void promise.catch(console.error);
      },
    } as Parameters<typeof complete>[1]);
  },
});

process.env.STUDIO_URL = server.url.origin;
const { default: channel } = await import("../agent/channels/openai-compat");
const complete = channel.routes!.find((route) => route.path === "/v1/chat/completions")!.handler;
console.log(server.url.origin);
