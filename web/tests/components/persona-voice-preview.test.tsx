import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";
import { emptyPersona } from "@/lib/persona";

type Scope = { values: unknown[]; cursor: number; cleanups: (() => void)[] };
const scopes: Scope[] = [];
let scope: Scope;
function newScope(): Scope {
  const next = { values: [], cursor: 0, cleanups: [] };
  scopes.push(next);
  return next;
}
const realReact = { ...React };
mock.module("react", () => ({
  ...realReact,
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
  useEffect: (effect: () => void | (() => void)) => {
    const index = scope.cursor++;
    if (index in scope.values) return;
    scope.values[index] = true;
    const cleanup = effect();
    if (cleanup) scope.cleanups.push(cleanup);
  },
}));
const error = mock();
mock.module("sonner", () => ({ toast: { error, success: mock() } }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push: mock(), refresh: mock() }) }));
mock.module("@/lib/use-refresh", () => ({ useRefresh: () => mock() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const requests: ReturnType<typeof deferred<Response>>[] = [];
const generateSpeech = mock<(voice: string, text: string, stream: boolean, signal: AbortSignal) => Promise<Response>>(() => {
  const request = deferred<Response>();
  requests.push(request);
  return request.promise;
});
const playPcmStream = mock<(response: Response, signal: AbortSignal) => Promise<void>>(async () => {});
const stopPlayback = mock();
mock.module("@/lib/audio-playback", () => ({ generateSpeech, playPcmStream, stopPlayback }));
const { PersonaEditor } = await import("@/components/persona/persona-editor");

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode; onClick(): void }>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function render<T>(target: Scope, component: () => T) {
  scope = target;
  scope.cursor = 0;
  return component();
}
function renderElement(target: Scope, element: Element) {
  if (typeof element.type !== "function") throw new Error("Expected a function component");
  const component = element.type as (props: Element["props"]) => ReactNode;
  return render(target, () => component(element.props));
}
function unmount(target: Scope) {
  target.cleanups.splice(0).forEach((cleanup) => cleanup());
}
function picker() {
  const root = render(newScope(), () => PersonaEditor({
    slug: "trainer", initial: { ...emptyPersona(), name: "Trainer" }, isOwn: true, defaultTab: "media",
    media: { photoUrl: null, hasVideo: false, voiceId: null, voiceName: null },
    voices: [{ id: "ava", name: "Ava", kind: "cloned" }, { id: "jules", name: "Jules", kind: "sample" }],
  }));
  const sectionElement = find(root, (element) => typeof element.type === "function" && element.type.name === "VoiceSection")!;
  const sectionScope = newScope();
  const section = () => renderElement(sectionScope, sectionElement);
  find(section(), (element) => element.props.children === "Choose a voice")!.props.onClick();
  const pickerElement = find(section(), (element) => typeof element.type === "function" && element.type.name === "VoicePicker")!;
  const pickerScope = newScope();
  const tree = () => renderElement(pickerScope, pickerElement);
  const button = (label: string) => find(tree(), (element) => element.props["aria-label"] === label)!;
  return { section, pickerScope, button };
}
beforeEach(() => {
  scopes.length = 0;
  requests.length = 0;
  for (const callback of [error, generateSpeech, playPcmStream, stopPlayback]) callback.mockClear();
});
afterEach(() => scopes.forEach(unmount));

test("the loading preview remains stoppable and an intentional abort is not an error", async () => {
  const ui = picker();
  ui.button("Listen to Ava").props.onClick();
  const signal = generateSpeech.mock.calls[0][3];
  expect(signal.aborted).toBe(false);
  expect(ui.button("Stop Ava").props.disabled).toBe(false);
  ui.button("Stop Ava").props.onClick();
  expect(signal.aborted).toBe(true);
  requests[0].reject(signal.reason);
  await expect(requests[0].promise).rejects.toBe(signal.reason);
  expect(playPcmStream).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(ui.button("Listen to Ava")).toBeDefined();
});

test("Cancel aborts the pending HTTP request and a late response never reaches playback", async () => {
  const ui = picker();
  ui.button("Listen to Ava").props.onClick();
  const signal = generateSpeech.mock.calls[0][3];
  find(ui.section(), (element) => element.props.children === "Cancel")!.props.onClick();
  unmount(ui.pickerScope);
  expect(signal.aborted).toBe(true);
  requests[0].resolve(new Response(new Uint8Array(480)));
  await requests[0].promise;
  expect(playPcmStream).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(stopPlayback).toHaveBeenCalled();
});

test("an old cancelled response cannot clear the next preview's loading/Stop state", async () => {
  const ui = picker();
  ui.button("Listen to Ava").props.onClick();
  ui.button("Stop Ava").props.onClick();
  ui.button("Listen to Jules").props.onClick();
  requests[0].resolve(new Response(new Uint8Array(480)));
  await requests[0].promise;
  expect(ui.button("Stop Jules")).toBeDefined();
  expect(playPcmStream).not.toHaveBeenCalled();
  ui.button("Stop Jules").props.onClick();
  const reason = generateSpeech.mock.calls[1][3].reason;
  requests[1].reject(reason);
  await expect(requests[1].promise).rejects.toBe(reason);
  expect(error).not.toHaveBeenCalled();
});

test.each([false, true])("unexpected network errors remain visible (stopped=%s)", async (stopped) => {
  const ui = picker();
  ui.button("Listen to Ava").props.onClick();
  if (stopped) ui.button("Stop Ava").props.onClick();
  const failed = new TypeError("The preview connection failed");
  requests[0].reject(failed);
  await expect(requests[0].promise).rejects.toBe(failed);
  expect(error).toHaveBeenCalledWith("The preview connection failed");
  expect(playPcmStream).not.toHaveBeenCalled();
});

test("Stop also aborts an active PCM consumer using the same request signal", async () => {
  const streaming = deferred<void>();
  playPcmStream.mockImplementationOnce(() => streaming.promise);
  const ui = picker();
  ui.button("Listen to Ava").props.onClick();
  const response = new Response(new Uint8Array(480));
  const signal = generateSpeech.mock.calls[0][3];
  requests[0].resolve(response);
  await requests[0].promise;
  expect(playPcmStream).toHaveBeenCalledWith(response, signal);
  ui.button("Stop Ava").props.onClick();
  expect(signal.aborted).toBe(true);
  expect(stopPlayback).toHaveBeenCalled();
  streaming.resolve();
  await streaming.promise;
  expect(error).not.toHaveBeenCalled();
});
