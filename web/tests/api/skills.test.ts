import { beforeEach, expect, mock, test } from "bun:test";
import { refusals } from "@/lib/errors";

let refusal: Error | null = null;
let requested: unknown;
let found = true;
mock.module("@/lib/org", () => ({
  studioOrg: async () => {
    if (refusal) throw refusal;
    return { id: "org-1" };
  },
}));
mock.module("@/lib/db", () => ({
  db: {
    skill: { findUnique: async (args: unknown) => {
      requested = args;
      return found ? {
        id: "skill-1", name: "Buyer", currentVersionId: "version-1",
        versions: [{ id: "version-1", version: 1, format: "builder-roleplay", status: "ready",
          indexStatus: "ready", contentHash: "hash", artifacts: "org-1/skills/skill-1/v1",
          itemCount: 0, failure: null, files: { "SKILL.md": "# Private instructions" }, createdAt: new Date(0) }],
      } : null;
    } },
  },
}));
const { GET } = await import("@/app/api/skills/[slug]/route");
const get = () => GET(new Request("http://localhost/api/skills/buyer"), { params: Promise.resolve({ slug: "buyer" }) });
beforeEach(() => { refusal = null; requested = undefined; found = true; });

test.each([refusals.signedOut(), refusals.studioOnly(), refusals.memberDisabled()])("refuses %s before looking up a skill", async (error) => {
  refusal = error;
  const response = await get();
  expect(response.status).toBe(error.status);
  expect(await response.json()).toMatchObject({ code: error.code });
  expect(requested).toBeUndefined();
});

test("registry inspection is org-scoped, uncached and excludes package content", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(requested).toMatchObject({ where: { orgId_ownerSlug: { orgId: "org-1", ownerSlug: "buyer" } } });
  const result = await response.json();
  expect(result.versions[0]).not.toHaveProperty("files");
  expect(JSON.stringify(result)).not.toContain("Private instructions");
});

test("refuses not_found for a missing or other-org owner", async () => {
  found = false;
  const response = await get();
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found.", code: "not_found" });
});
