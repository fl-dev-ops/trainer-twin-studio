import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AgentDispatch, AgentDispatchClient, Room, RoomServiceClient } from "livekit-server-sdk";
import { activateLiveKitSession } from "@/lib/livekit";

let saved: Record<string, string | undefined>;
let listRooms: ReturnType<typeof spyOn<RoomServiceClient, "listRooms">>;
let createRoom: ReturnType<typeof spyOn<RoomServiceClient, "createRoom">>;
let updateRoom: ReturnType<typeof spyOn<RoomServiceClient, "updateRoomMetadata">>;
let listDispatch: ReturnType<typeof spyOn<AgentDispatchClient, "listDispatch">>;
let createDispatch: ReturnType<typeof spyOn<AgentDispatchClient, "createDispatch">>;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  const env = { LIVEKIT_URL: "ws://127.0.0.1:1", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-secret", AWS_S3_BUCKET: "", S3_BUCKET: "" };
  saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  listRooms = spyOn(RoomServiceClient.prototype, "listRooms").mockResolvedValue([]);
  createRoom = spyOn(RoomServiceClient.prototype, "createRoom").mockResolvedValue(new Room());
  updateRoom = spyOn(RoomServiceClient.prototype, "updateRoomMetadata").mockResolvedValue(new Room());
  listDispatch = spyOn(AgentDispatchClient.prototype, "listDispatch").mockResolvedValue([]);
  createDispatch = spyOn(AgentDispatchClient.prototype, "createDispatch").mockResolvedValue(new AgentDispatch({ id: "dispatch" }));
  fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in metadata test"));
});
afterEach(() => {
  for (const spy of [listRooms, createRoom, updateRoom, listDispatch, createDispatch, fetchMock]) spy.mockRestore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const input = { sessionId: "session", userId: "user", orgId: "org", runtimeToken: "token" };

test.each(["TWIN", "ROLEPLAY"])("room and dispatch metadata carry the absolute deadline and %s agent kind", async (agentKind) => {
  await activateLiveKitSession({ ...input, endsAt: 1234567890, agentKind });
  const metadata = createRoom.mock.calls[0][0].metadata!;
  expect(JSON.parse(metadata)).toMatchObject({ ends_at: 1234567890, agent_kind: agentKind });
  expect(JSON.parse(metadata)).not.toHaveProperty("runtimeToken");
  expect(JSON.parse(createDispatch.mock.calls[0][2]!.metadata!)).toEqual({ ...JSON.parse(metadata), runtimeToken: input.runtimeToken });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("studio metadata has no deadline, but keeps the kind for the correct goodbye", async () => {
  await activateLiveKitSession({ ...input, agentKind: "TWIN" });
  const metadata = JSON.parse(createRoom.mock.calls[0][0].metadata!);
  expect(metadata).not.toHaveProperty("ends_at");
  expect(metadata.agent_kind).toBe("TWIN");
  expect(metadata).not.toHaveProperty("runtimeToken");
});

test("an existing room's metadata is refreshed with its deadline", async () => {
  listRooms.mockResolvedValue([new Room({ name: "session" })]);
  await activateLiveKitSession({ ...input, endsAt: 1234567890, agentKind: "ROLEPLAY" });
  expect(createRoom).not.toHaveBeenCalled();
  expect(updateRoom.mock.calls[0][0]).toBe("session");
  expect(JSON.parse(updateRoom.mock.calls[0][1])).toMatchObject({ ends_at: 1234567890, agent_kind: "ROLEPLAY" });
  expect(JSON.parse(updateRoom.mock.calls[0][1])).not.toHaveProperty("runtimeToken");
  expect(JSON.parse(createDispatch.mock.calls[0][2]!.metadata!).runtimeToken).toBe(input.runtimeToken);
});
