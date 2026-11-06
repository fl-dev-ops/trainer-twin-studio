import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@livekit/components-react", () => ({
  useStartAudio: () => ({ mergedProps: {}, canPlayAudio: false }),
  useTrackToggle: () => ({ buttonProps: {}, enabled: false, pending: false }),
  useVoiceAssistant: () => ({ state: "listening" }),
}));

const { SessionControlBar } = await import("@/components/session/session-control-bar");
const { SessionSidebar } = await import("@/components/session/session-sidebar");

const props = {
  isConnected: true,
  chatOpen: true,
  onChatToggle: () => {},
  onEnd: () => {},
  onAttach: () => {},
};

test("all call controls fit the compact mobile layout with accessible names", () => {
  const html = renderToStaticMarkup(<SessionControlBar {...props} />);
  for (const name of ["Turn on camera", "Unmute microphone", "Chat", "Attach a file", "End session"]) {
    expect(html).toContain(`aria-label="${name}"`);
  }
  expect(html).toContain('title="Enable audio"');
  expect(html).toContain('class="sr-only md:not-sr-only">Enable audio</span>');
  expect(html).toContain('class="sr-only md:not-sr-only">End</span>');
  expect(html).toContain("md:col-start-2");
  expect(html).toContain("md:col-start-3");
});

test("controls remain hidden until connected", () => {
  expect(renderToStaticMarkup(<SessionControlBar {...props} isConnected={false} />)).toBe("");
});

test("chat fills its mobile sheet without losing close or message controls", () => {
  const html = renderToStaticMarkup(
    <SessionSidebar entries={[]} onClose={() => {}} onSendMessage={() => {}} className="w-full rounded-none border-0" />,
  );
  expect(html).toContain("w-full");
  expect(html).not.toContain("w-[360px]");
  expect(html).toContain('aria-label="Close chat"');
  expect(html).toContain('aria-label="Message the trainer"');
  expect(html).toContain('aria-label="Send message"');
});
