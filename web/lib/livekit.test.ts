import assert from "node:assert/strict";
import test from "node:test";
import { TokenVerifier } from "livekit-server-sdk";
import { createLiveKitSessionToken, getLiveKitConfig } from "./livekit";

const configured = {
  LIVEKIT_URL: "wss://example.livekit.cloud",
  LIVEKIT_API_KEY: "key",
  LIVEKIT_API_SECRET: "secret",
};

test("LiveKit config requires server credentials", () => {
  assert.throws(() => getLiveKitConfig({}), /LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET/);
});

test("LiveKit config validates the websocket URL and resolves the agent", () => {
  assert.throws(() => getLiveKitConfig({ ...configured, LIVEKIT_URL: "https://example.com" }), /ws:\/\/ or wss:\/\//);
  assert.equal(getLiveKitConfig(configured).agentName, "intervoo-agent");
  assert.equal(getLiveKitConfig({ ...configured, LIVEKIT_AGENT_NAME: "trainer" }).agentName, "trainer");
});

test("createLiveKitSessionToken generates token with RoomConfiguration and agent dispatch per LiveKit docs", async () => {
  const origEnv = { ...process.env };
  try {
    process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
    process.env.LIVEKIT_API_KEY = "testkey";
    process.env.LIVEKIT_API_SECRET = "testsecret012345678901234567890123";
    process.env.LIVEKIT_AGENT_NAME = "intervoo-agent";

    const result = await createLiveKitSessionToken({
      sessionId: "session-123",
      userId: "user-456",
      userName: "Alex",
      runtimeToken: "rt-tok-789",
      orgId: "org-1",
      agentSlug: "lead-engineer",
    });

    assert.equal(result.url, "wss://example.livekit.cloud");
    assert.equal(result.room, "session-session-123");

    const verifier = new TokenVerifier("testkey", "testsecret012345678901234567890123");
    const claims = await verifier.verify(result.token);

    assert.equal(claims.video?.roomJoin, true);
    assert.equal(claims.video?.roomCreate, true);
    assert.equal(claims.video?.room, "session-session-123");
    assert.equal(claims.roomConfig?.name, "session-session-123");
    assert.equal(claims.roomConfig?.agents?.length, 1);
    assert.equal(claims.roomConfig?.agents?.[0]?.agentName, "intervoo-agent");

    const meta = JSON.parse(claims.roomConfig?.agents?.[0]?.metadata ?? "{}");
    assert.equal(meta.sessionId, "session-123");
    assert.equal(meta.agent_id, "lead-engineer");
    assert.equal(meta.runtimeToken, "rt-tok-789");
  } finally {
    process.env = origEnv;
  }
});
