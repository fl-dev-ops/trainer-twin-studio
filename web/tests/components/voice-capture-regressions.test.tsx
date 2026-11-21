import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";
import { VOICE_PASSAGES } from "@/lib/voice-passage";

type Scope = { values: unknown[]; cursor: number; effects: boolean; cleanups: (() => void)[] };
const scopes: Scope[] = [];
let scope: Scope;
function newScope(effects = true, values: unknown[] = []): Scope {
  const next = { values, cursor: 0, effects, cleanups: [] };
  scopes.push(next);
  return next;
}
const realReact = { ...React };
mock.module("react", () => ({
  ...realReact,
  useId: () => "voice-capture",
  useState: (initial: unknown) => {
    const { values } = scope;
    const index = scope.cursor++;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = scope.cursor++;
    if (!(index in scope.values)) scope.values[index] = { current: initial };
    return scope.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const index = scope.cursor++;
    if (index in scope.values) return;
    scope.values[index] = true;
    if (scope.effects) {
      const cleanup = effect();
      if (cleanup) scope.cleanups.push(cleanup);
    }
  },
}));
const push = mock();
const refresh = mock();
const success = mock();
const error = mock();
const saveVoice = mock(async () => {});
mock.module("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
mock.module("@/lib/use-refresh", () => ({ useRefresh: () => refresh }));
mock.module("sonner", () => ({ toast: { success, error } }));
mock.module("@/lib/twin/client", () => ({ twinClient: { avatar: {
  videoUploadUrl: { mutate: async () => ({ url: "https://upload.test/take", key: "avatar/reference.webm" }) },
  saveVoice: { mutate: saveVoice },
} } }));
let convert: () => Promise<Blob>;
mock.module("@/lib/wav", () => ({ recordingToWav: () => convert() }));
const { VoiceCreateForm } = await import("@/components/voice-library");
const { VoiceRecorder } = await import("@/components/voice-recorder");
const { TwinVoiceCapture } = await import("@/components/twin/twin-voice-capture");

type Element = ReactElement<Record<string, unknown> & {
  children?: ReactNode;
  onClick(): void | Promise<void>;
  onChange(event: { currentTarget: { value?: string; files?: File[] } }): void;
  onValueChange(value: string): void;
  onSubmit(event: { preventDefault(): void }): Promise<void>;
  onFinished(wav: Blob): void;
  onStreamReady(stream: { getTracks(): { stop(): void }[] }): void;
}>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function render<T>(target: Scope, component: () => T): T {
  scope = target;
  scope.cursor = 0;
  return component();
}
function unmount(target: Scope) {
  target.cleanups.splice(0).forEach((cleanup) => cleanup());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const recordings: RecordingFixture[] = [];
class RecordingFixture {
  mimeType = "audio/webm";
  state = "inactive";
  onstop: (() => void | Promise<void>) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  stopped = Promise.resolve();
  constructor() { recordings.push(this); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["captured-audio"]) });
    this.stopped = Promise.resolve(this.onstop?.());
  }
}
const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: RecordingFixture });
const fetchSpy = spyOn(globalThis, "fetch");
const nowSpy = spyOn(Date, "now");
const uploads: FormData[] = [];
let now = 0;
beforeEach(() => {
  scopes.length = 0;
  recordings.length = 0;
  uploads.length = 0;
  now = 0;
  nowSpy.mockImplementation(() => now);
  convert = async () => new Blob(["wav"], { type: "audio/wav" });
  for (const callback of [push, refresh, success, error, saveVoice]) callback.mockClear();
  fetchSpy.mockImplementation(async (input, init) => {
    if (String(input) === "https://upload.test/take") return new Response(null, { status: 200 });
    if (String(input) !== "/api/tts/voices" || !(init?.body instanceof FormData)) throw new Error("Unexpected capture HTTP request");
    const name = String(init.body.get("name") ?? "");
    uploads.push(init.body);
    if (!name || name.length > 60) return Response.json({ error: "Invalid voice name" }, { status: 400 });
    return Response.json({ voice: { id: "voice-created", name, status: "ready" } });
  });
});
afterEach(() => {
  scopes.forEach(unmount);
  fetchSpy.mockReset();
});
afterAll(() => {
  fetchSpy.mockRestore();
  nowSpy.mockRestore();
  if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
  else Reflect.deleteProperty(globalThis, "MediaRecorder");
});

test("a delayed recorder conversion after switching to Upload cannot replace the chosen MP3", async () => {
  const pending = deferred<Blob>();
  convert = () => pending.promise;
  const formScope = newScope();
  const recorderScope = newScope();
  const form = () => render(formScope, () => VoiceCreateForm({ onCancel: mock() }));
  find(form(), (element) => element.props.id === "voice-capture-name")!.props.onChange({ currentTarget: { value: "Wanted upload" } });
  const onFinished = find(form(), (element) => element.type === VoiceRecorder)!.props.onFinished;
  const capture = () => render(recorderScope, () => VoiceRecorder({ onFinished }));
  find(capture(), (element) => element.props.children?.toString().includes("Start recording") === true)!.props.onClick();
  const trackStop = mock();
  find(capture(), (element) => typeof element.props.onStreamReady === "function")!.props.onStreamReady({ getTracks: () => [{ stop: trackStop }] });
  const recorder = recordings[0];
  now = 11_000;
  find(capture(), (element) => element.props.variant === "strong" && typeof element.props.onClick === "function")!.props.onClick();
  expect(recorder.state).toBe("inactive");
  find(form(), (element) => typeof element.props.onValueChange === "function")!.props.onValueChange("upload");
  unmount(recorderScope);
  const wanted = new File(["wanted-audio"], "wanted.mp3", { type: "audio/mpeg" });
  find(form(), (element) => element.props.id === "voice-capture-audio")!.props.onChange({ currentTarget: { files: [wanted] } });
  pending.resolve(new Blob(["late-recording"], { type: "audio/wav" }));
  await recorder.stopped;
  await find(form(), (element) => element.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect(uploads).toHaveLength(1);
  const uploaded = uploads[0].get("audio");
  if (!(uploaded instanceof File)) throw new Error("Expected the chosen upload");
  expect(uploaded.name).toBe("wanted.mp3");
  expect(uploaded.type).toBe("audio/mpeg");
  expect(await uploaded.text()).toBe("wanted-audio");
  expect(uploads[0].get("transcript")).toBe("");
  expect(error).not.toHaveBeenCalled();
  expect(trackStop).toHaveBeenCalled();
});

test.each([52, 53, 120])("trainer capture keeps the generated voice name within 60 characters for a %i-character persona", async (length) => {
  const refs = [{ current: null }, { current: null }, { current: null }, { current: 0 }];
  const take = { video: new Blob(["video"]), audio: new Blob(["audio"]), contentType: "video/webm", url: "blob:take" };
  const target = newScope(false, [...refs, "", true, "review", VOICE_PASSAGES[0], false, 20, take, ""]);
  const name = "N".repeat(length);
  const done = deferred<void>();
  push.mockImplementation(() => done.resolve());
  error.mockImplementation(() => done.resolve());
  const tree = render(target, () => TwinVoiceCapture({ personaName: name }));
  find(tree, (element) => element.props.children === "Save")!.props.onClick();
  await done.promise;
  expect(error).not.toHaveBeenCalled();
  expect(uploads).toHaveLength(1);
  const generated = String(uploads[0].get("name"));
  expect(generated.length).toBeLessThanOrEqual(60);
  expect(generated).toBe(`${name.slice(0, 52)}'s voice`);
  expect(uploads[0].get("transcript")).toBe(VOICE_PASSAGES[0]);
  expect(saveVoice).toHaveBeenCalledWith({ voiceId: "voice-created", videoKey: "avatar/reference.webm" });
  expect(push).toHaveBeenCalledWith("/twin/brain");
  expect(error).not.toHaveBeenCalled();
});
