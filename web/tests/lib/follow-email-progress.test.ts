import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

const loading = mock((_message: string, _options?: unknown) => "invite-toast");
const success = mock((_message: string, _options?: unknown) => {});
const warning = mock((_message: string, _options?: unknown) => {});
const info = mock((_message: string, _options?: unknown) => {});
const dismiss = mock((_id: string) => {});
mock.module("sonner", () => ({ toast: { loading, success, warning, info, dismiss } }));
const { followEmailProgress } = await import("@/lib/follow-email-progress");
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  for (const fn of [loading, success, warning, info, dismiss]) fn.mockClear();
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => { fetchSpy.mockRestore(); });

function stream(...chunks: string[]) {
  const encoder = new TextEncoder();
  fetchSpy.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } })));
}

test("followEmailProgress buffers split NDJSON lines, skips blanks and updates one toast before success", async () => {
  stream('\n{"to":"a@example.com","status":"se', 'nt"}\n{"to":"b@example.com","status":"sent"}\n{"status":"done",', '"sent":2,"failed":[]}\n');
  await followEmailProgress("run.signature/+", 2);
  expect(fetchSpy).toHaveBeenCalledWith("/api/runs/run.signature%2F%2B");
  expect(loading.mock.calls).toEqual([
    ["Sending 2 invite emails…"],
    ["Sending invite emails… 1 of 2", { id: "invite-toast" }],
    ["Sending invite emails… 2 of 2", { id: "invite-toast" }],
  ]);
  expect(success).toHaveBeenCalledTimes(1);
  expect(success).toHaveBeenCalledWith("2 invite emails sent", { id: "invite-toast" });
  expect(dismiss).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled();
});

test("followEmailProgress uses singular email on a successful one-person batch", async () => {
  stream('{"to":"a@example.com","status":"sent"}\n{"status":"done","sent":1,"failed":[]}\n');
  await followEmailProgress("token", 1);
  expect(loading.mock.calls[0]).toEqual(["Sending 1 invite email…"]);
  expect(success).toHaveBeenCalledWith("1 invite email sent", { id: "invite-toast" });
});

test.each([0, 1])("followEmailProgress reports failed addresses with %i sent in a fresh 15-second warning", async (sent) => {
  stream(`${sent ? '{"to":"ok@example.com","status":"sent"}\n' : ""}{"to":"a@example.com","status":"failed"}\n{"to":"b@example.com","status":"failed"}\n${JSON.stringify({ status: "done", sent, failed: ["a@example.com", "b@example.com"] })}\n`);
  await followEmailProgress("token", sent + 2);
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(dismiss).toHaveBeenCalledWith("invite-toast");
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(`${sent ? "1 invite email sent. " : ""}Couldn't send the invite email to a@example.com, b@example.com.`, { duration: 15_000 });
  expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(warning.mock.invocationCallOrder[0]);
  expect(success).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled();
});

test.each(["fetch", "http", "missing-body", "stream", "invalid-json"])("followEmailProgress keeps delivery in the background on %s errors", async (failure) => {
  if (failure === "fetch") fetchSpy.mockRejectedValue(new Error("offline"));
  else if (failure === "http") fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
  else if (failure === "missing-body") fetchSpy.mockResolvedValue(new Response(null));
  else if (failure === "stream") fetchSpy.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("disconnected")); } })));
  else stream("not json\n");
  await followEmailProgress("token", 2);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("The invite emails are going out in the background.", { id: "invite-toast" });
  expect(success).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
});
