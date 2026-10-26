import { beforeEach, expect, mock, test } from "bun:test";

process.env.COPILOT_SERVICE_SECRET = "s3cret";

let kind = "TWIN";
let lookups = 0;
let closed: { id: string; status: string; data: Record<string, unknown> }[] = [];
let processed: string[] = [];

mock.module("@/lib/db", () => ({
  db: {
    interviewSession: {
      findFirst: async () => { lookups += 1; return { id: "s1", agent: { kind } }; },
    },
  },
}));
mock.module("@/lib/session-lifecycle", () => ({
  closeInterviewSession: async (id: string, status: string, data: Record<string, unknown>) => {
    closed.push({ id, status, data });
    return { finalStatus: status, id };
  },
}));
mock.module("@/lib/session-processing", () => ({
  processCompletedSession: async (id: string) => { processed.push(id); return true; },
}));

const { POST } = await import("@/app/api/sessions/webhook/route");

const call = (body: unknown, auth?: string) =>
  POST(new Request("https://web.test/api/sessions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  }));

const agentPayload = {
  session_id: "s1",
  room_name: "session-s1",
  audio_url: null,
  video_s3_key: "org/recordings/s1/video.mp4",
  status: "COMPLETED",
  participant_identity: null,
  transcript: [{ role: "user", text: "How do I follow up?" }, { role: "trainer", text: "Same evening." }],
};

beforeEach(() => { kind = "TWIN"; lookups = 0; closed = []; processed = []; });

test("missing or wrong secret is refused before anything is read or changed", async () => {
  expect((await call(agentPayload)).status).toBe(401);
  expect((await call(agentPayload, "Bearer nope")).status).toBe(401);
  expect(lookups).toBe(0);
  expect(closed).toEqual([]);
});

test("a malformed payload is refused", async () => {
  expect((await call({ session_id: "s1", transcript: "not a list" }, "Bearer s3cret")).status).toBe(400);
  expect(closed).toEqual([]);
});

test("twin: the agent's transcript replaces the browser's and is marked final", async () => {
  const response = await call(agentPayload, "Bearer s3cret");
  expect(response.status).toBe(200);
  expect(closed).toHaveLength(1);
  expect(closed[0].data.replaceTranscript).toBe(true);
  expect(closed[0].data.transcript).toEqual(agentPayload.transcript);
  expect(closed[0].data.evidence).toEqual({ videoS3Key: "org/recordings/s1/video.mp4", transcriptFinal: true });
  expect(processed).toEqual(["s1"]);
});

test("role play: first transcript still wins and no twin marker is added", async () => {
  kind = "ROLEPLAY";
  await call(agentPayload, "Bearer s3cret");
  expect(closed[0].data.replaceTranscript).toBe(false);
  expect(closed[0].data.evidence).toEqual({ videoS3Key: "org/recordings/s1/video.mp4" });
});
