import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { generateSpeech, playPcmStream, splitPcm, stopPlayback } from "@/lib/audio-playback";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const buffers: Float32Array[] = [];
const sources: TestSource[] = [];
let onStart: (() => void) | undefined;
class TestSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  connect = mock();
  start = mock(() => onStart?.());
  stop = mock();
}
class TestAudioContext {
  currentTime = 0;
  destination = {};
  resume = mock(async () => {});
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    buffers.push(data);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const source = new TestSource();
    sources.push(source);
    return source;
  }
}
const originalContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
const fetchSpy = spyOn(globalThis, "fetch");
beforeAll(() => Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: TestAudioContext }));
beforeEach(() => {
  stopPlayback();
  buffers.length = 0;
  sources.length = 0;
  onStart = undefined;
  fetchSpy.mockRejectedValue(new Error("Unexpected HTTP request in audio playback test"));
});
afterEach(() => {
  stopPlayback();
  fetchSpy.mockReset();
});
afterAll(() => {
  fetchSpy.mockRestore();
  if (originalContext) Object.defineProperty(globalThis, "AudioContext", originalContext);
  else Reflect.deleteProperty(globalThis, "AudioContext");
});

test("PCM split at odd byte boundaries keeps every sample intact and returns the tail at the end", () => {
  const samples = Int16Array.from({ length: 1003 }, (_, i) => (i * 37) % 30000 - 15000);
  const bytes = new Uint8Array(samples.buffer);
  // Chunk sizes that often end mid-sample, as network reads do.
  const sizes = [1, 2, 7, 333, 64, 5, 999, 3];
  let carry: Uint8Array = new Uint8Array(0);
  const out: number[] = [];
  let at = 0;
  for (let i = 0; at < bytes.length; i++) {
    const end = Math.min(bytes.length, at + sizes[i % sizes.length]);
    const next = splitPcm(carry, bytes.subarray(at, end), 100);
    next.slices.forEach((slice) => out.push(...slice));
    carry = next.carry;
    at = end;
  }
  const last = splitPcm(carry, new Uint8Array(0), 100, true);
  last.slices.forEach((slice) => out.push(...slice));
  expect(last.carry.length).toBe(0);
  expect(out).toEqual([...samples]);
});

test("a late HTTP response after cancellation is discarded before scheduling audio", async () => {
  const pending = deferred<Response>();
  const controller = new AbortController();
  const cancel = mock();
  fetchSpy.mockImplementation(() => pending.promise);
  const playback = generateSpeech("voice", "Preview", true, controller.signal).then((response) => playPcmStream(response, controller.signal));
  const rejected = playback.catch((error: unknown) => error);
  expect(fetchSpy.mock.calls[0][1]?.signal).toBe(controller.signal);
  controller.abort();
  pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(buffers).toHaveLength(0);
  expect(sources).toHaveLength(0);
});

test("already-cancelled playback rejects before creating a source and cancels its body", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancel = mock();
  await expect(playPcmStream(new Response(new ReadableStream<Uint8Array>({ cancel })), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(sources).toHaveLength(0);
});

test.each(["stop", "abort"] as const)("%s during a pending stream read discards later chunks and the PCM tail", async (action) => {
  const started = deferred<void>();
  onStart = () => started.resolve();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = mock();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { producer = controller; }, cancel });
  const controller = new AbortController();
  producer.enqueue(new Uint8Array(new Int16Array(4801).buffer));
  const playback = playPcmStream(new Response(stream), action === "abort" ? controller.signal : undefined);
  await started.promise;
  producer.enqueue(new Uint8Array(new Int16Array(4800).buffer));
  if (action === "abort") controller.abort();
  else stopPlayback();
  await playback;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(buffers).toHaveLength(1);
  expect(buffers[0]).toHaveLength(4800);
  expect(sources).toHaveLength(1);
  expect(sources[0].stop).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
  expect(() => producer.enqueue(new Uint8Array(4))).toThrow();
});

test("normal streamed PCM still preserves odd-byte framing and the final short buffer", async () => {
  const samples = Int16Array.from({ length: 1003 }, (_, index) => (index * 37) % 30000 - 15000);
  const bytes = new Uint8Array(samples.buffer);
  const sizes = [1, 2, 7, 333, 64, 5, 999, 3];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0, chunk = 0; at < bytes.length; chunk++) {
        const end = Math.min(bytes.length, at + sizes[chunk % sizes.length]);
        controller.enqueue(bytes.slice(at, end));
        at = end;
      }
      controller.close();
    },
  });
  await playPcmStream(new Response(stream, { headers: { "X-Sample-Rate": "500" } }));
  expect(buffers.map((buffer) => buffer.length)).toEqual([...Array<number>(10).fill(100), 3]);
  expect(buffers.flatMap((buffer) => [...buffer])).toEqual([...Float32Array.from(samples, (sample) => sample / 32768)]);
  expect(stream.locked).toBe(false);
});

test("unexpected stream and cancellation errors are propagated", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { producer = controller; } });
  const playback = playPcmStream(new Response(stream));
  const networkError = new Error("The preview connection failed");
  const rejected = playback.catch((error: unknown) => error);
  producer.error(networkError);
  expect(await rejected).toBe(networkError);
  expect(stream.locked).toBe(false);

  const cancellationError = new Error("The stream could not be cancelled");
  const failingCancel = playPcmStream(new Response(new ReadableStream<Uint8Array>({ cancel() { throw cancellationError; } })));
  const cancelled = failingCancel.catch((error: unknown) => error);
  stopPlayback();
  expect(await cancelled).toBe(cancellationError);
});

test("existing three-argument speech callers keep PCM/WAV defaults and the original response", async () => {
  const wav = new Response("wav");
  const pcm = new Response("pcm");
  fetchSpy.mockResolvedValueOnce(wav).mockResolvedValueOnce(pcm);
  expect(await generateSpeech("voice", "Full preview", false)).toBe(wav);
  expect(await generateSpeech("voice", "Streamed preview")).toBe(pcm);
  expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({ voice: "voice", input: "Full preview", stream: false, response_format: "wav" });
  expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({ voice: "voice", input: "Streamed preview", stream: true, response_format: "pcm" });
  expect(wav.bodyUsed).toBe(false);
  expect(pcm.bodyUsed).toBe(false);
});
