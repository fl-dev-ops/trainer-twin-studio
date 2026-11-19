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
const persona = { ...emptyPersona(), name: "Trainer", role: "Sales coach", about: "Coaches new agents." };

function editor(props: Partial<ComponentProps<typeof PersonaEditor>> = {}) {
  return renderToStaticMarkup(
    <PersonaEditor slug="trainer" initial={persona} voices={voices} voice={{ id: "shared-voice", name: "Shared recording" }} {...props} />,
  );
}

const view = (patch: Record<string, unknown> = {}) => ({
  slug: "trainer", isOwn: false, version: 1, updatedAt: "2026-11-19T00:00:00.000Z",
  persona, traits: [], voice: null, photoUrl: null, hasVideo: false, usedBy: [], ...patch,
});

test("the form has exactly five fields and no advanced settings", () => {
  const html = editor();
  for (const label of ["Name", "Role", "About this person", "Voice", "Photo"]) expect(html).toContain(label);
  expect(html).toContain('id="p-name"');
  expect(html).toContain('id="p-role"');
  expect(html).toContain('id="p-about"');
  expect(html).toContain('id="p-photo"');
  expect(html).toContain("Current voice:");
  expect(html).toContain("Shared recording");
  expect(html).toContain("Choose a voice");
  expect(html).toContain("Add my voice");
  expect(html).toContain("Save changes");
  expect(html).toContain("Cancel");
  for (const removed of ["Behaviour", "Opening style", "Formality", "Answer length", "Interrupts", "Signature phrases", "Speaking pace", "Age", "Based in",
    "How they talk", "Voice and avatar", 'role="tab"', 'id="p-video"', "Advanced"]) {
    expect(html).not.toContain(removed);
  }
  expect(html).not.toContain("unavailable for new voice sessions");
  expect(html).not.toContain('type="radio"');
});

test("the role field is free text with suggestions, and the form keeps the saved values", () => {
  const html = editor();
  expect(html).toContain('value="Sales coach"');
  expect(html).toContain("<datalist");
  expect(html).toContain('value="Buyer"');
  expect(html).toContain("Coaches new agents.");
});

test("own personas keep their photo on Twin's brain", () => {
  const html = editor({ isOwn: true });
  expect(html).toContain("Choose a voice");
  expect(html).toContain('href="/twin/brain"');
  expect(html).not.toContain('id="p-photo"');
});

test("an unavailable current voice is preserved with a clear explanation", () => {
  const html = editor({ voice: { id: "old-voice", name: "Old recording" } });
  expect(html).toContain("Old recording");
  expect(html).toContain("The current voice is unavailable for new voice sessions.");
  expect(html).toContain("It stays selected until you save another voice.");
});

test("a persona with no voice stays empty instead of choosing the first voice", () => {
  const html = editor({ voice: null });
  expect(html).toContain("No voice yet. Choose or add one before starting a voice session.");
  expect(html).not.toContain("Current voice:");
});

test("a shared persona says how many agents an edit affects; a new one does not", () => {
  const used = [{ slug: "a", name: "Discovery call", kind: "ROLEPLAY" }, { slug: "b", name: "Objections", kind: "ROLEPLAY" }];
  const html = editor({ usedBy: used });
  expect(html).toContain("Used by 2 agents.");
  expect(html).toContain("Changes apply to their next sessions.");
  expect(renderToStaticMarkup(<PersonaEditor initial={emptyPersona()} voices={voices} />)).not.toContain("Used by");
});

test("the persona page shows the five fields, users and earlier settings read-only", () => {
  const html = renderToStaticMarkup(<PersonaDetail item={view({
    usedBy: [{ slug: "a", name: "Discovery call", kind: "ROLEPLAY" }, { slug: "t", name: "Trainer twin", kind: "TWIN" }],
    traits: [{ label: "Behaviour", value: "Skeptical & Reserved" }],
  })} />);
  expect(html).toContain("Coaches new agents.");
  expect(html).toContain("Discovery call");
  expect(html).toContain("Trainer twin");
  expect(html).toContain("Earlier settings");
  expect(html).toContain("Skeptical &amp; Reserved");
  expect(renderToStaticMarkup(<PersonaDetail item={view()} />)).not.toContain("Earlier settings");
});

test("an own persona's missing voice links to its editor and missing photo to Twin's brain", () => {
  const html = renderToStaticMarkup(<PersonaDetail item={view({ isOwn: true })} />);
  expect(html).toContain('href="/personas/trainer/edit"');
  expect(html).toContain('href="/twin/brain"');
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
