import assert from "node:assert/strict";
import test from "node:test";
import { orgDatabaseName, parseChromaUrl } from "./chroma-tenant";
import { MainCollectionService } from "./main-collection";
import { LearnerMemoryService } from "./learner-memory";

test("organization databases use immutable IDs", () => {
  assert.equal(orgDatabaseName("8f5c-id"), "org_8f5c-id");
  assert.equal(orgDatabaseName("unsafe/id"), "org_unsafe_id");
});

test("ChromaTenantService parses and resolves tenant metadata", async () => {
  const orgNameA = "test-org-123";
  const orgNameB = "test-org-456";

  const collectionA = MainCollectionService.getCollectionName(orgNameA, false);
  const collectionB = MainCollectionService.getCollectionName(orgNameB, false);
  assert.equal(collectionA, "main");
  assert.equal(collectionB, "main");

  const sharedA = MainCollectionService.getCollectionName(orgNameA, true);
  const sharedB = MainCollectionService.getCollectionName(orgNameB, true);
  assert.equal(sharedA, "org_test-org-123_main");
  assert.equal(sharedB, "org_test-org-456_main");
  assert.notEqual(sharedA, sharedB);
});

test("LearnerMemoryService generates isolated learner collection names", () => {
  const orgId = "org-xyz";
  const user1 = "user-1";
  const user2 = "user-2";

  const col1 = LearnerMemoryService.getCollectionName(orgId, user1, false);
  const col2 = LearnerMemoryService.getCollectionName(orgId, user2, false);
  assert.equal(col1, "learner_user-1");
  assert.equal(col2, "learner_user-2");
  assert.notEqual(col1, col2);

  const shared1 = LearnerMemoryService.getCollectionName(orgId, user1, true);
  const shared2 = LearnerMemoryService.getCollectionName(orgId, user2, true);
  assert.equal(shared1, "org_org-xyz_learner_user-1");
  assert.equal(shared2, "org_org-xyz_learner_user-2");
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

