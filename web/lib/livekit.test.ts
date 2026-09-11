import assert from "node:assert/strict";
import test from "node:test";
import { getLiveKitConfig } from "./livekit";

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
