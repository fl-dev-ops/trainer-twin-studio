import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";

const realReact = { ...React };
let state: unknown[] = [];
let cursor = 0;
mock.module("react", () => ({
  ...realReact,
  useId: () => "voice-create",
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
    return [state[index], (value: unknown) => { state[index] = value; }];
  },
}));
const refresh = mock();
mock.module("@/lib/use-refresh", () => ({ useRefresh: () => refresh }));
mock.module("sonner", () => ({ toast: { success: mock(), error: mock() } }));

const { VoiceCreateForm } = await import("@/components/voice-library");
const { VoiceRecorder } = await import("@/components/voice-recorder");
const cancel = mock();
const saved = mock();
let onCreated: Parameters<typeof VoiceCreateForm>[0]["onCreated"];
const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
const fetchSpy = spyOn(globalThis, "fetch");

type Element = ReactElement<Record<string, unknown> & {
  children?: ReactNode;
  onChange(event: { currentTarget: { value?: string; files?: File[] } }): void;
  onFinished(wav: Blob): void;
  onValueChange(value: string): void;
  onSubmit(event: { preventDefault(): void }): Promise<void>;
  onClick(): void;
}>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function render() {
  cursor = 0;
  return VoiceCreateForm({ onCreated, onCancel: cancel, onSaved: saved });
}
const field = (id: string) => find(render(), (element) => element.props.id === `voice-create-${id}`)!;
const submit = () => find(render(), (element) => element.type === "form")!.props.onSubmit({ preventDefault() {} });

beforeEach(() => {
  state = [];
  cursor = 0;
  onCreated = undefined;
  requests.length = 0;
  for (const callback of [cancel, saved, refresh]) callback.mockClear();
  fetchSpy.mockImplementation(async (input, init) => {
    requests.push({ input, init });
    return Response.json({ voice: { id: "created-voice", name: "My voice", status: "ready" } });
  });
});
afterEach(() => fetchSpy.mockReset());
afterAll(() => fetchSpy.mockRestore());

test("finishing a recording stages WAV and its fixed passage until an explicit Save", async () => {
  const initial = render();
  const passage = find(initial, (element) => element.type === "p" && element.props.className === "m-0 text-sm leading-6")!.props.children;
  expect(typeof passage).toBe("string");
  field("name").props.onChange({ currentTarget: { value: "My recorded voice" } });
  find(render(), (element) => element.type === VoiceRecorder)!.props.onFinished(new Blob(["recorded-wave"], { type: "audio/wav" }));
  expect(requests).toHaveLength(0);
  expect(find(render(), (element) => element.props.role === "status")!.props.children).toBe("Recording ready to save.");
  await submit();
  expect(requests).toHaveLength(1);
  expect(requests[0].input).toBe("/api/tts/voices");
  const form = requests[0].init?.body;
  expect(form).toBeInstanceOf(FormData);
  if (!(form instanceof FormData)) throw new Error("Expected multipart voice upload");
  expect(form.get("name")).toBe("My recorded voice");
  expect(form.get("transcript")).toBe(passage);
  const audio = form.get("audio");
  expect(audio).toBeInstanceOf(File);
  if (!(audio instanceof File)) throw new Error("Expected a WAV recording");
  expect(audio.name).toBe("reference.wav");
  expect(audio.type).toBe("audio/wav");
  expect(await audio.text()).toBe("recorded-wave");
  expect(saved).toHaveBeenCalledTimes(1);
});

test("upload sends the original filename and MIME without assuming the recording passage", async () => {
  field("name").props.onChange({ currentTarget: { value: "My uploaded voice" } });
  find(render(), (element) => typeof element.props.onValueChange === "function")!.props.onValueChange("upload");
  const audio = new File(["existing-clip"], "original-clip.mp3", { type: "audio/mpeg" });
  field("audio").props.onChange({ currentTarget: { files: [audio] } });
  expect(requests).toHaveLength(0);
  await submit();
  const form = requests[0].init?.body;
  if (!(form instanceof FormData)) throw new Error("Expected multipart voice upload");
  expect(form.get("name")).toBe("My uploaded voice");
  expect(form.get("transcript")).toBe("");
  const uploaded = form.get("audio");
  if (!(uploaded instanceof File)) throw new Error("Expected the uploaded audio file");
  expect(uploaded.name).toBe("original-clip.mp3");
  expect(uploaded.type).toBe("audio/mpeg");
  expect(await uploaded.text()).toBe("existing-clip");
});

test("Cancel after capture creates nothing, and changing source clears the staged audio", () => {
  field("name").props.onChange({ currentTarget: { value: "Discarded voice" } });
  find(render(), (element) => element.type === VoiceRecorder)!.props.onFinished(new Blob(["recording"]));
  find(render(), (element) => element.props.children === "Cancel")!.props.onClick();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(0);
  find(render(), (element) => typeof element.props.onValueChange === "function")!.props.onValueChange("upload");
  expect(find(render(), (element) => element.props.type === "submit")!.props.disabled).toBe(true);
});

test("retrying a failed attachment reuses the standalone voice instead of uploading again", async () => {
  const attachments: string[] = [];
  onCreated = async (voice) => {
    attachments.push(voice.id);
    if (attachments.length === 1) throw new Error("The voice changed while saving. Try again.");
  };
  field("name").props.onChange({ currentTarget: { value: "My recorded voice" } });
  find(render(), (element) => element.type === VoiceRecorder)!.props.onFinished(new Blob(["recording"]));
  await submit();
  expect(requests).toHaveLength(1);
  expect(saved).not.toHaveBeenCalled();
  expect(find(render(), (element) => element.props.role === "alert")!.props.children).toBe("The voice changed while saving. Try again.");
  await submit();
  expect(requests).toHaveLength(1);
  expect(attachments).toEqual(["created-voice", "created-voice"]);
  expect(saved).toHaveBeenCalledTimes(1);
});
