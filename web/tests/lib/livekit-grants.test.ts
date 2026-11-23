import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentDispatch, AgentDispatchClient, Room, RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
import { activateLiveKitSession } from "@/lib/livekit";

const now = new Date("2030-01-01T00:00:00Z");
const env = {
  LIVEKIT_URL: "wss://livekit.test",
  LIVEKIT_API_KEY: "grant-test-key",
  LIVEKIT_API_SECRET: "grant-test-secret",
  AWS_S3_BUCKET: "",
  S3_BUCKET: "",
};
let saved: Record<string, string | undefined>;
let listRooms: ReturnType<typeof spyOn<RoomServiceClient, "listRooms">>;
let createRoom: ReturnType<typeof spyOn<RoomServiceClient, "createRoom">>;
let listDispatch: ReturnType<typeof spyOn<AgentDispatchClient, "listDispatch">>;
let createDispatch: ReturnType<typeof spyOn<AgentDispatchClient, "createDispatch">>;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const input = {
  sessionId: "public-session",
  userId: "visitor-public-session",
  userName: "Visitor",
  orgId: "org-public",
  runtimeToken: "dispatch-only-runtime-token",
  agentKind: "TWIN",
};
const verifier = new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  setSystemTime(now);
  listRooms = spyOn(RoomServiceClient.prototype, "listRooms").mockResolvedValue([]);
  createRoom = spyOn(RoomServiceClient.prototype, "createRoom").mockResolvedValue(new Room());
  listDispatch = spyOn(AgentDispatchClient.prototype, "listDispatch").mockResolvedValue([]);
  createDispatch = spyOn(AgentDispatchClient.prototype, "createDispatch").mockResolvedValue(new AgentDispatch({ id: "dispatch" }));
  fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in grant test"));
});

afterEach(() => {
  for (const spy of [listRooms, createRoom, listDispatch, createDispatch, fetchMock]) spy.mockRestore();
  setSystemTime();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.each([60, 120, 300])("anonymous JWT restricts publishing to microphone and expires at the persisted %i-second deadline", async (allowedSeconds) => {
  const startedAt = now.getTime() / 1000 - 20;
  const endsAt = startedAt + allowedSeconds;
  const result = await activateLiveKitSession({ ...input, anonymous: true, endsAt });
  const claims = await verifier.verify(result.token, 0);

  expect(claims).toMatchObject({
    iss: env.LIVEKIT_API_KEY,
    sub: `user-${input.userId}`,
    name: input.userName,
    nbf: now.getTime() / 1000,
    exp: endsAt,
  });
  expect(claims.video).toEqual({
    roomJoin: true, room: input.sessionId, canPublish: true, canSubscribe: true,
    canPublishData: true, canPublishSources: ["microphone"],
  });
  expect(result.room).toBe(input.sessionId);
  const metadata = JSON.parse(createRoom.mock.calls[0][0].metadata!);
  expect(metadata).toMatchObject({
    orgId: input.orgId, sessionId: input.sessionId, anonymous: true, ends_at: endsAt,
  });
  expect(metadata).not.toHaveProperty("runtimeToken");
  expect(JSON.parse(createDispatch.mock.calls[0][2]!.metadata!)).toEqual({
    ...metadata, runtimeToken: input.runtimeToken,
  });
  expect(JSON.stringify(claims)).not.toContain(input.runtimeToken);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([undefined, false])("signed-in JWT retains unrestricted sources and SDK default TTL (anonymous=%s)", async (anonymous) => {
  const result = await activateLiveKitSession({
    ...input, userId: "learner", anonymous, endsAt: now.getTime() / 1000 + 120,
  });
  const claims = await verifier.verify(result.token, 0);

  expect(claims).toMatchObject({
    iss: env.LIVEKIT_API_KEY, sub: "user-learner", name: input.userName,
    nbf: now.getTime() / 1000, exp: now.getTime() / 1000 + 6 * 60 * 60,
  });
  expect(claims.video).toEqual({
    roomJoin: true, room: input.sessionId, canPublish: true, canSubscribe: true, canPublishData: true,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
