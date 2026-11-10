import { beforeEach, expect, mock, test } from "bun:test";
import { progressToken } from "@/lib/run-progress";
import type { EmailProgress } from "@/workflows/invite-emails";

let org: { id: string } | null = { id: "org-1" };
let exists = true;
const events: EmailProgress[] = [
  { to: "a@example.com", status: "sent" },
  { to: "b@example.com", status: "failed" },
  { status: "done", sent: 1, failed: ["b@example.com"] },
];
const getReadable = mock(() => new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(event);
  controller.close();
} }));
const getRun = mock((_runId: string) => ({ exists: Promise.resolve(exists), getReadable }));
mock.module("@/lib/org", () => ({ getTrainerOrg: async () => org }));
mock.module("workflow/api", () => ({ getRun }));
const { GET } = await import("@/app/api/runs/[token]/route");
const read = (token = progressToken("org-1", "wrun_1")) => GET(new Request(`https://dash.example.com/api/runs/${token}`), { params: Promise.resolve({ token }) });
beforeEach(() => { org = { id: "org-1" }; exists = true; getRun.mockClear(); getReadable.mockClear(); });

test("GET runs requires a trainer org before looking up any run", async () => {
  org = null;
  const response = await read();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
  expect(getRun).not.toHaveBeenCalled();
});

test.each(["wrong-org", "tampered", "unsigned"])("GET runs returns 404 for %s tokens without looking up a run", async (kind) => {
  const token = kind === "wrong-org" ? progressToken("org-2", "wrun_1")
    : kind === "tampered" ? progressToken("org-1", "wrun_1").replace("wrun_1", "wrun_2") : "wrun_1";
  const response = await read(token);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found" });
  expect(getRun).not.toHaveBeenCalled();
});

test("GET runs returns 404 when a signed run no longer exists", async () => {
  exists = false;
  const response = await read();
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found" });
  expect(getRun).toHaveBeenCalledWith("wrun_1");
  expect(getReadable).not.toHaveBeenCalled();
});

test("GET runs returns ordered newline-delimited progress with no-store caching", async () => {
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe(events.map((event) => JSON.stringify(event) + "\n").join(""));
  expect(getRun).toHaveBeenCalledWith("wrun_1");
  expect(getReadable).toHaveBeenCalledTimes(1);
});
