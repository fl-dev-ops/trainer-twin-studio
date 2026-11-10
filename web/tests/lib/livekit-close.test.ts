import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AgentDispatchClient, EgressClient, RoomServiceClient } from "livekit-server-sdk";
import { closeLiveKitSession } from "@/lib/livekit";

const saved = Object.fromEntries(["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].map((key) => [key, process.env[key]]));
let stop: ReturnType<typeof spyOn<EgressClient, "stopEgress">>;
let dispatch: ReturnType<typeof spyOn<AgentDispatchClient, "deleteDispatch">>;
let room: ReturnType<typeof spyOn<RoomServiceClient, "deleteRoom">>;
const input = { room: "room-s1", dispatchId: "dispatch-s1", videoEgressId: "egress-s1" };

beforeEach(() => {
  process.env.LIVEKIT_URL = "wss://livekit.test";
  process.env.LIVEKIT_API_KEY = "test-key";
  process.env.LIVEKIT_API_SECRET = "test-secret";
  stop = spyOn(EgressClient.prototype, "stopEgress").mockResolvedValue({} as never);
  dispatch = spyOn(AgentDispatchClient.prototype, "deleteDispatch").mockResolvedValue(undefined);
  room = spyOn(RoomServiceClient.prototype, "deleteRoom").mockResolvedValue(undefined);
});
afterEach(() => {
  stop.mockRestore(); dispatch.mockRestore(); room.mockRestore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("strict close stops recording, removes dispatch, then deletes room", async () => {
  await closeLiveKitSession(input, { strict: true });
  expect(stop).toHaveBeenCalledWith("egress-s1");
  expect(dispatch).toHaveBeenCalledWith("dispatch-s1", "room-s1");
  expect(room).toHaveBeenCalledWith("room-s1");
  expect(stop.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
  expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(room.mock.invocationCallOrder[0]);
});

test("missing room does no work; absent optional ids only delete the room", async () => {
  await closeLiveKitSession({ ...input, room: null }, { strict: true });
  expect(stop).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(room).not.toHaveBeenCalled();
  await closeLiveKitSession({ room: "room-s1" }, { strict: true });
  expect(stop).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  expect(room).toHaveBeenCalledWith("room-s1");
});

for (const stage of ["stop", "dispatch", "room"] as const) {
  test.each([{ status: 404 }, { code: "not_found" }, { code: "failed_precondition" }])(`strict: ${stage} already gone is ignored and cleanup continues (%j)`, async (error) => {
    ({ stop, dispatch, room })[stage].mockRejectedValueOnce(error);
    await expect(closeLiveKitSession(input, { strict: true })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1); expect(room).toHaveBeenCalledTimes(1);
  });
  test.each([Object.assign(new Error("service down"), { status: 503 }), { status: 403, code: "permission_denied" }, new Error("network down"), null])(`strict: ${stage} unexpected failure is rethrown unchanged (%j)`, async (error) => {
    ({ stop, dispatch, room })[stage].mockRejectedValueOnce(error);
    await expect(closeLiveKitSession(input, { strict: true })).rejects.toBe(error);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(stage === "stop" ? 0 : 1);
    expect(room).toHaveBeenCalledTimes(stage === "room" ? 1 : 0);
  });
}

test.each([undefined, { strict: false }])("non-strict ignores all SDK errors and attempts every cleanup operation (%j)", async (options) => {
  stop.mockRejectedValueOnce(new Error("egress down"));
  dispatch.mockRejectedValueOnce({ status: 403, code: "permission_denied" });
  room.mockRejectedValueOnce(new Error("room down"));
  await expect(closeLiveKitSession(input, options)).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1); expect(room).toHaveBeenCalledTimes(1);
});
