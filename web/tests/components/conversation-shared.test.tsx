import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Room } from "livekit-client";

const toggle = mock(async (_value?: boolean) => {});
mock.module("@livekit/components-react", () => ({
  useTrackToggle: () => ({ toggle, enabled: true, pending: false }),
  useVoiceAssistant: () => ({ state: "speaking" }),
}));
const { useCallMicrophone, micProblem } = await import("@/hooks/use-call-microphone");
const { CallComposer } = await import("@/components/conversation/controls");
const { Bubble, TwinPortrait } = await import("@/components/calibration/parts");
const { ConversationBubble, ConversationPortrait } = await import("@/components/conversation/parts");
const { SessionSidebar } = await import("@/components/session/session-sidebar");

function control(room: Room) {
  let result: ReturnType<typeof useCallMicrophone>;
  function Capture() { result = useCallMicrophone(room); return null; }
  renderToStaticMarkup(<Capture />);
  return result!;
}

test("twin and role-play portraits and bubbles share the same rendered markup", () => {
  expect(renderToStaticMarkup(<TwinPortrait name="Vasanth" />)).toBe(renderToStaticMarkup(<ConversationPortrait name="Vasanth" />));
  expect(renderToStaticMarkup(<Bubble speaker="you">Hello</Bubble>)).toBe(renderToStaticMarkup(<ConversationBubble from="you">Hello</ConversationBubble>));
  expect(renderToStaticMarkup(<Bubble speaker="twin">Hello</Bubble>)).toBe(renderToStaticMarkup(<ConversationBubble from="agent">Hello</ConversationBubble>));
});

test("a browser-paused mic is restarted by the shared control before enabling capture", async () => {
  toggle.mockClear();
  const restartTrack = mock(async () => {});
  const room = { localParticipant: { getTrackPublication: () => ({ track: { restartTrack, mediaStreamTrack: { readyState: "ended", muted: false } } }) } } as unknown as Room;
  await control(room).onClick();
  expect(restartTrack).toHaveBeenCalledTimes(1);
  expect(toggle).toHaveBeenCalledWith(true);
});

test("a healthy microphone uses LiveKit's toggle rather than separate UI state", async () => {
  toggle.mockClear();
  const room = { localParticipant: { getTrackPublication: () => undefined } } as unknown as Room;
  const mic = control(room);
  expect(mic.enabled).toBe(true);
  await mic.onClick();
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(micProblem(new DOMException("denied", "NotAllowedError"))).toContain("Allow it for this site");
});

test("the shared composer preserves message length and accessible labels", () => {
  const html = renderToStaticMarkup(<CallComposer name="Vasanth" onSend={() => {}} disabled />);
  expect(html).toContain("Message Vasanth");
  expect(html).toContain('maxLength="2000"');
  expect(html).toContain('aria-label="Send message"');
  expect(html).toContain("disabled");
});

test("completed transcript text is not repeated as a streaming bubble", () => {
  const html = renderToStaticMarkup(<SessionSidebar entries={[{ role: "trainer", text: "One final reply" }]} liveText="One final reply" />);
  expect(html.split("One final reply")).toHaveLength(2);
});
