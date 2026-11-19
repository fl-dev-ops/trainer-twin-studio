import { expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyPersona } from "@/lib/persona";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: mock(), refresh: mock() }) }));
mock.module("@/lib/use-refresh", () => ({ useRefresh: () => mock() }));

const { PersonaEditor } = await import("@/components/persona/persona-editor");
const { PersonaDetail } = await import("@/components/persona/persona-detail");
const { VoiceCreateForm, VoiceLibrary } = await import("@/components/voice-library");

const voices = [
  { id: "shared-voice", name: "Shared recording", kind: "cloned" },
  { id: "sample-voice", name: "Sample recording", kind: "sample" },
];
const persona = { ...emptyPersona(), name: "Trainer", role: "Sales coach" };

function editor(props: Partial<ComponentProps<typeof PersonaEditor>> = {}) {
  return renderToStaticMarkup(
    <PersonaEditor slug="trainer" initial={persona} defaultTab="media" voices={voices}
      media={{ photoUrl: null, hasVideo: true, voiceId: "shared-voice", voiceName: "Shared recording" }} {...props} />,
  );
}

test("voice controls preserve the saved voice and keep the existing persona tabs", () => {
  const html = editor();
  expect(html).toContain("Current voice:");
  expect(html).toContain("Shared recording");
  expect(html).toContain("Choose a voice");
  expect(html).toContain("Add my voice");
  expect(html).toContain("Look");
  expect(html).toContain("How they talk");
  expect(html).toContain("Voice and avatar");
  expect(html).not.toContain("unavailable for new voice sessions");
  expect(html).not.toContain("copied");
  expect(html).not.toContain('type="radio"');
});

test("own personas can choose or add a voice without exposing avatar uploads", () => {
  const html = editor({ isOwn: true });
  expect(html).toContain("Choose a voice");
  expect(html).toContain("Add my voice");
  expect(html).toContain("You can still record your voice there.");
  expect(html).toContain('href="/twin/brain"');
  expect(html).not.toContain('id="p-image"');
  expect(html).not.toContain('id="p-video"');
});

test("an unavailable current voice is preserved with a clear explanation", () => {
  const html = editor({ media: { photoUrl: null, hasVideo: false, voiceId: "old-voice", voiceName: "Old recording" } });
  expect(html).toContain("Old recording");
  expect(html).toContain("The current voice is unavailable for new voice sessions.");
  expect(html).toContain("It stays selected until you save another voice.");
  expect(html).not.toContain("Current voice: <b class=\"font-semibold\">Shared recording");
});

test("a persona with no voice stays empty instead of choosing the first voice", () => {
  const html = editor({ media: { photoUrl: null, hasVideo: false, voiceId: null, voiceName: null } });
  expect(html).toContain("No voice yet. Choose or add one before starting a voice session.");
  expect(html).not.toContain("Current voice:");
});

test("an own persona's missing-voice link opens its voice editor", () => {
  const html = renderToStaticMarkup(<PersonaDetail item={{
    slug: "trainer", isOwn: true, version: 1, updatedAt: "2026-11-19T00:00:00.000Z",
    persona, voice: null, photoUrl: null, hasVideo: true,
  }} />);
  expect(html).toContain('href="/personas/trainer/edit?tab=media"');
});

test("the voice library offers Listen without generation controls", () => {
  const html = renderToStaticMarkup(<VoiceLibrary mine={[{
    ...voices[0], status: "ready", createdAt: "2026-11-19T00:00:00.000Z",
  }]} samples={[]} />);
  expect(html).toContain('aria-label="Listen to Shared recording"');
  expect(html).toContain("Explore voices");
  expect(html).toContain("My voices");
  expect(html).not.toContain("Generate voice");
  expect(html).not.toContain("Stability");
  expect(html).not.toContain("Similarity");
});

test("the creation form exposes only a name and recording/upload with explicit Save and Cancel", () => {
  const html = renderToStaticMarkup(<VoiceCreateForm onCancel={mock()} />);
  expect(html).toContain("Voice name");
  expect(html).toContain('maxLength="60"');
  expect(html).toContain("Record");
  expect(html).toContain("Upload");
  expect(html).toContain("Save voice");
  expect(html).toContain("Cancel");
  expect(html).not.toContain("Try another text");
  expect(html).not.toContain("Reference text");
  expect(html).not.toContain("Stability");
});
