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

test("call controls use shared buttons with accessible names and can wrap on narrow screens", () => {
  const html = renderToStaticMarkup(<SessionControlBar {...props} />);
  for (const name of ["Turn on camera", "Unmute microphone", "Chat", "Attach a file", "End session"]) {
    expect(html).toContain(`aria-label="${name}"`);
  }
  expect(html).toContain('title="Enable audio"');
  expect(html).toContain(">Enable audio</button>");
  expect(html).toContain(">End</button>");
  expect(html.match(/data-slot="button"/g)).toHaveLength(6);
  expect(html).toContain("flex-wrap");
});

test("controls remain hidden until connected", () => {
  expect(renderToStaticMarkup(<SessionControlBar {...props} isConnected={false} />)).toBe("");
});

test("chat fills its mobile sheet without losing close or message controls", () => {
  const html = renderToStaticMarkup(
    <SessionSidebar entries={[]} onClose={() => {}} onSendMessage={() => {}} className="w-full rounded-none" />,
  );
  expect(html).toContain("w-full");
  expect(html).not.toContain("w-[360px]");
  expect(html).toContain('aria-label="Close chat"');
  expect(html).toContain('aria-label="Message the trainer"');
  expect(html).toContain('aria-label="Send message"');
});

test("chat uses a 32px pill without divider lines or an input border", () => {
  const html = renderToStaticMarkup(<SessionSidebar entries={[]} />);
  const input = html.match(/<input\b[^>]*>/)?.[0];
  expect(input).toContain("h-8");
  expect(input).toContain("rounded-full bg-muted");
  expect(input).toContain("focus-visible:ring-2");
  expect(html).not.toMatch(/\bborder(?:-\w+)?\b/);
});
