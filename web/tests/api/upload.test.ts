import { beforeEach, describe, expect, mock, test } from "bun:test";

const user = { id: "learner", email: "harini@foreverlearning.in" };
let member: { role: string; disabledAt: Date | null } | null = null;
const saveUpload = mock(async () => ({ id: "doc", name: "resume.txt", kind: "text", manifest: {} }));
const startUpload = mock(async () => ({ id: "doc", putUrl: "https://s3.test/upload", contentType: "text/plain" }));

mock.module("@/lib/session-user", () => ({
  resolveSessionUser: async () => ({ org: { id: "demo" }, user }),
}));
mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
  db: {
    member: {
      findFirst: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        member && where.organizationId === "demo" && where.userId === user.id
          ? { id: "member", createdAt: new Date(0), ...member, user: { ...user, name: "Learner", image: null } }
          : null,
    },
  },
}));
mock.module("@/lib/org", () => ({
  getSessionOrg: async () => ({ id: "demo" }), getTrainerOrg: async () => null,
}));
mock.module("@/lib/specs", () => ({ listUploads: async () => [], saveUpload }));
mock.module("@/lib/uploads", () => ({
  startUpload, UPLOAD_PURPOSES: ["before", "during", "copilot"], UploadError: class extends Error {},
}));

const { POST: upload } = await import("../../app/api/upload/route");
const { POST: uploads } = await import("../../app/api/uploads/route");

function request(code = "practice-code") {
  const form = new FormData();
  form.set("file", new File(["resume"], "resume.txt", { type: "text/plain" }));
  if (code) form.set("shareCode", code);
  return new Request("https://latencytest.trainertwin.com/api/upload", { method: "POST", body: form });
}
function presignedRequest(purpose: "before" | "during", code = "practice-code") {
  return new Request("https://latencytest.trainertwin.com/api/uploads", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "resume.txt", mimeType: "text/plain", size: 6, purpose, ...(code ? { shareCode: code } : {}) }),
  });
}

beforeEach(() => { member = null; saveUpload.mockClear(); startUpload.mockClear(); });

describe.each([
  { name: "POST /api/upload", post: upload, request, status: 200, saved: saveUpload },
  { name: "POST /api/uploads before", post: uploads, request: (code?: string) => presignedRequest("before", code), status: 201, saved: startUpload },
  { name: "POST /api/uploads during", post: uploads, request: (code?: string) => presignedRequest("during", code), status: 201, saved: startUpload },
])("$name membership access", ({ post, request, status, saved }) => {
  test("non-members cannot upload with or without a share code", async () => {
    for (const code of ["practice-code", "common-twin-code", ""]) {
      const response = await post(request(code));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
    }
    expect(saveUpload).not.toHaveBeenCalled();
    expect(startUpload).not.toHaveBeenCalled();
  });

  test.each(["user", "team", "admin"])("enabled %s members can upload without relying on a code or assignment", async (role) => {
    member = { role, disabledAt: null };
    expect((await post(request(""))).status).toBe(status);
    expect((await post(request("spent-link"))).status).toBe(status);
    expect(saved).toHaveBeenCalledTimes(2);
  });

  test.each(["user", "team", "admin"])("disabled %s members cannot upload even with a share code", async (role) => {
    member = { role, disabledAt: new Date() };
    for (const code of ["common-twin-code", ""]) {
      const response = await post(request(code));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
    }
    expect(saveUpload).not.toHaveBeenCalled();
    expect(startUpload).not.toHaveBeenCalled();
  });
});
