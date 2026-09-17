import assert from "node:assert/strict";
import test from "node:test";
import { deploymentAllowsMode, deploymentAllowsOrigin, deploymentPublicKey } from "./deployments";

test("deployment keys and mode policy", () => {
  assert.match(deploymentPublicKey(), /^tt_pub_/);
  assert.equal(deploymentAllowsMode("chat,voice", "chat"), true);
  assert.equal(deploymentAllowsMode("voice", "chat"), false);
  assert.equal(deploymentAllowsOrigin(null, "https://app.example.com"), true);
  assert.equal(deploymentAllowsOrigin(["https://app.example.com"], "https://app.example.com"), true);
  assert.equal(deploymentAllowsOrigin(["https://app.example.com"], "https://evil.example"), false);
});
