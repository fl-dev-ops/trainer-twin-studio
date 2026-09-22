import assert from "node:assert/strict";
import test from "node:test";
import { orgDatabaseName, parseChromaUrl } from "../../../lib/chroma-tenant";
import { LearnerMemoryService } from "../../../lib/learner-memory";

test("organization databases use immutable IDs", () => {
  assert.equal(orgDatabaseName("8f5c-id"), "org_8f5c-id");
  assert.equal(orgDatabaseName("unsafe/id"), "org_unsafe_id");
});

test("LearnerMemoryService generates isolated learner collection names", () => {
  const col1 = LearnerMemoryService.getCollectionName("user-1");
  const col2 = LearnerMemoryService.getCollectionName("user-2");
  assert.equal(col1, "learner_user-1");
  assert.equal(col2, "learner_user-2");
  assert.notEqual(col1, col2);
  assert.equal(LearnerMemoryService.getCollectionName("unsafe/id"), "learner_unsafe_id");
});

test("parseChromaUrl correctly extracts host, port, and ssl flags", () => {
  const local = parseChromaUrl("http://localhost:8000");
  assert.equal(local.host, "localhost");
  assert.equal(local.port, 8000);
  assert.equal(local.ssl, false);

  const cloud = parseChromaUrl("https://api.trychroma.com");
  assert.equal(cloud.host, "api.trychroma.com");
  assert.equal(cloud.port, 443);
  assert.equal(cloud.ssl, true);

  const custom = parseChromaUrl("https://custom-chroma.internal:9443");
  assert.equal(custom.host, "custom-chroma.internal");
  assert.equal(custom.port, 9443);
  assert.equal(custom.ssl, true);
});

