import { expect, test, type Page, type Request } from "@playwright/test";
import superjson from "superjson";
import { emptyPersona } from "../lib/persona";
import { as } from "./seed-data";

test.use(as("admin"));

const SLUG = "voice-ui-persona";
const voices = [
  { id: "shared-a", name: "Shared voice", kind: "cloned" },
  { id: "shared-b", name: "Shared voice", kind: "cloned" },
  { id: "sample-c", name: "Jules", kind: "sample" },
];
const personaData = (isOwn = false, voice = { id: voices[0].id, name: voices[0].name }) => ({
  item: {
    slug: SLUG, isOwn, version: 1, updatedAt: "2026-11-19T00:00:00.000Z",
    persona: { ...emptyPersona(), name: "Voice UI Trainer", role: "Sales coach" },
    photoUrl: null, hasVideo: true, voice,
  },
  voices,
});

async function mockQuery(page: Page, method: string, data: () => unknown) {
  await page.route((url) => url.pathname.startsWith("/api/trpc/") && url.pathname.split("/").at(-1)?.split(",").includes(method) === true, async (route) => {
    const methods = new URL(route.request().url()).pathname.split("/").at(-1)!.split(",");
    const original = await route.fetch();
    const payload: unknown = await original.json();
    if (!Array.isArray(payload)) throw new Error("Expected a batched tRPC response");
    const json = payload.map((result, index) => methods[index] === method ? { result: { data: superjson.serialize(data()) } } : result);
    await route.fulfill({ status: 200, json });
  });
}

async function multipart(request: Request) {
  const bytes = request.postDataBuffer();
  if (!bytes) throw new Error("Expected multipart request data");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": request.headers()["content-type"] } }).formData();
}

function voiceSection(page: Page) {
  return page.locator("article").filter({ has: page.getByRole("heading", { name: "Voice", exact: true }) });
}

function referenceWav() {
  const rate = 24_000;
  const pcm = Buffer.alloc(rate);
  for (let sample = 0; sample < pcm.length / 2; sample++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * sample / rate) * 2048), sample * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

test("local voice references are shared without extra Voice rows and preview through the real API and S3 (synthetic inference)", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  async function addVoice(name: string) {
    const response = await page.request.post("/api/tts/voices", {
      multipart: { name, transcript: "Synthetic reference recording for browser verification.", audio: { name: "reference.wav", mimeType: "audio/wav", buffer: referenceWav() } },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const result: { voice: { id: string; name: string; status: string } } = await response.json();
    expect(result.voice.status).toBe("ready");
    return result.voice;
  }
  async function addPersona(name: string) {
    const response = await page.request.post("/api/personas", { data: { ...emptyPersona(), name, behaviours: ["Warm & Open"] } });
    expect(response.status(), await response.text()).toBe(201);
    const result: { slug: string } = await response.json();
    return result.slug;
  }
  async function voiceIds() {
    const response = await page.request.get("/api/tts/voices");
    expect(response.ok(), await response.text()).toBe(true);
    const result: { voices: { id: string }[] } = await response.json();
    return result.voices.map((voice) => voice.id).sort();
  }
  async function metadata(id: string) {
    const response = await page.request.get(`/api/tts/voices/${id}`, { headers: { authorization: "Bearer e2e-tts-app" } });
    expect(response.ok(), await response.text()).toBe(true);
    const result: { id: string; version: string; audioUrl: string; transcript: string | null } = await response.json();
    const url = new URL(result.audioUrl);
    expect(url.origin).toBe("http://127.0.0.1:9100");
    expect(url.pathname).toMatch(/^\/olga-local\/voice-e2e\//);
    return { id: result.id, version: result.version, reference: url.pathname, transcript: result.transcript };
  }
  async function listen(name: string) {
    const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/tts/speech" && candidate.request().method() === "POST");
    await voiceSection(page).getByRole("button", { name: `Listen to ${name}`, exact: true }).click();
    const preview = await response;
    expect(preview.status(), await preview.text()).toBe(200);
    expect(preview.headers()["content-type"]).toContain("audio/pcm");
    expect(preview.headers()["x-sample-rate"]).toBe("24000");
    expect((await preview.body()).length).toBeGreaterThan(0);
    await expect(voiceSection(page).getByRole("button", { name: `Listen to ${name}`, exact: true })).toBeEnabled();
    await expect(page.getByText(/Preview failed|Local voice resolution failed/)).toHaveCount(0);
  }
  const shared = await addVoice(`E2E shared ${stamp}`);
  const alternative = await addVoice(`E2E other ${stamp}`);
  const first = await addPersona(`E2E voice first ${stamp}`);
  const second = await addPersona(`E2E voice second ${stamp}`);
  const initial = await page.request.post(`/api/personas/${first}/media`, { multipart: { voiceId: shared.id } });
  expect(initial.ok(), await initial.text()).toBe(true);
  const idsBefore = await voiceIds();
  const referenceBefore = await metadata(shared.id);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/personas/${second}/media`) mutations.push(request.url());
  });
  await page.goto(`/personas/${second}/edit?tab=media`);
  const section = voiceSection(page);
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator(`input[value="${shared.id}"]`)).toBeVisible();
  await expect(section.locator('input[type="radio"]:checked')).toHaveCount(0);
  await listen(shared.name);
  expect(mutations).toHaveLength(0);
  await section.locator(`input[value="${shared.id}"]`).check();
  await section.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mutations).toHaveLength(0);
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator('input[type="radio"]:checked')).toHaveCount(0);
  await section.locator(`input[value="${shared.id}"]`).check();
  const attached = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/personas/${second}/media`);
  await section.getByRole("button", { name: "Save voice", exact: true }).click();
  const saved = await attached;
  expect(saved.ok(), await saved.text()).toBe(true);
  const selected = await multipart(saved.request());
  expect([...selected.keys()]).toEqual(["voiceId"]);
  expect(selected.get("voiceId")).toBe(shared.id);
  await expect(section).toContainText(`Current voice: ${shared.name}`);
  expect(await voiceIds()).toEqual(idsBefore);
  expect(await metadata(shared.id)).toEqual(referenceBefore);
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator(`input[value="${shared.id}"]`)).toBeChecked();
  await expect(section.getByRole("button", { name: "Save voice", exact: true })).toBeDisabled();
  await section.locator(`input[value="${alternative.id}"]`).check();
  const switched = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/personas/${second}/media`);
  await section.getByRole("button", { name: "Save voice", exact: true }).click();
  expect((await switched).ok()).toBe(true);
  await expect(section).toContainText(`Current voice: ${alternative.name}`);
  expect(await voiceIds()).toEqual(idsBefore);
  expect(await metadata(shared.id)).toEqual(referenceBefore);
  await page.goto(`/personas/${first}/edit?tab=media`);
  await expect(voiceSection(page)).toContainText(`Current voice: ${shared.name}`);
  await voiceSection(page).getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(voiceSection(page).locator(`input[value="${shared.id}"]`)).toBeChecked();
  await listen(shared.name);
  const deletion = await page.request.delete(`/api/tts/voices/${shared.id}`);
  expect(deletion.status()).toBe(409);
  expect(await deletion.json()).toMatchObject({ code: "voice_in_use" });
  expect(await metadata(shared.id)).toEqual(referenceBefore);
});

test("Add my voice stages an upload, Cancel creates nothing, and one Save creates one named voice", async ({ page }) => {
  const name = `E2E uploaded voice ${Date.now()}`;
  const clip = { name: "original-source.wav", mimeType: "audio/wav", buffer: referenceWav() };
  async function ids() {
    const response = await page.request.get("/api/tts/voices");
    expect(response.ok(), await response.text()).toBe(true);
    const result: { voices: { id: string }[] } = await response.json();
    return result.voices.map((voice) => voice.id).sort();
  }
  const before = await ids();
  const uploads: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tts/voices") uploads.push(request);
  });
  await page.goto("/voice/cloning");
  await page.getByLabel("Voice name", { exact: true }).fill("Discarded upload");
  await page.getByRole("tab", { name: "Upload", exact: true }).click();
  await page.getByLabel("Recording", { exact: true }).setInputFiles(clip);
  expect(uploads).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/voice$/);
  expect(uploads).toHaveLength(0);
  expect(await ids()).toEqual(before);
  await page.getByRole("button", { name: "Add my voice", exact: true }).click();
  await expect(page).toHaveURL(/\/voice\/cloning$/);
  await expect(page.getByLabel("Voice name", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save voice", exact: true })).toBeDisabled();
  await page.getByLabel("Voice name", { exact: true }).fill(name);
  await page.getByRole("tab", { name: "Upload", exact: true }).click();
  await page.getByLabel("Recording", { exact: true }).setInputFiles(clip);
  await expect(page.getByText("Reference text", { exact: false })).toHaveCount(0);
  expect(uploads).toHaveLength(0);
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tts/voices" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save voice", exact: true }).click();
  const response = await created;
  expect(response.ok(), await response.text()).toBe(true);
  const result: { voice: { id: string; name: string; status: string } } = await response.json();
  expect(result.voice).toMatchObject({ name, status: "ready" });
  await expect(page).toHaveURL(/\/voice$/);
  expect(uploads).toHaveLength(1);
  const resolved = await page.request.get(`/api/tts/voices/${result.voice.id}`, { headers: { authorization: "Bearer e2e-tts-app" } });
  expect(resolved.ok(), await resolved.text()).toBe(true);
  const reference: { audioUrl: string; transcript: string | null } = await resolved.json();
  expect(reference.transcript).toBeNull();
  const url = new URL(reference.audioUrl);
  expect(url.origin).toBe("http://127.0.0.1:9100");
  expect(url.pathname).toMatch(/^\/olga-local\/voice-e2e\//);
  const stored = await page.request.get(reference.audioUrl);
  expect(stored.ok()).toBe(true);
  expect(stored.headers()["content-type"]).toContain(clip.mimeType);
  expect(await stored.body()).toEqual(clip.buffer);
  expect(await ids()).toEqual([...before, result.voice.id].sort());
  await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
});

test.describe("browser UI contracts with intercepted APIs", () => {
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/tts/**", async (route) => {
    await route.fulfill({ status: 503, json: { error: "Unexpected TTS request in intercepted UI contract" } });
    throw new Error(`Unexpected TTS request in intercepted UI contract: ${route.request().url()}`);
  });
});

test("voice selection is ID-based, preview-only until Save, and Cancel discards it (intercepted preview)", async ({ page }) => {
  const data = personaData();
  await mockQuery(page, "page.personaEdit", () => data);
  const attached: string[][] = [];
  let created = 0;
  let previews = 0;
  await page.route("**/api/tts/voices", async (route) => {
    created++;
    await route.fulfill({ status: 500, json: { error: "Selecting must not create a voice" } });
  });
  await page.route("**/api/tts/speech", async (route) => {
    previews++;
    expect(route.request().postDataJSON().voice).toBe("sample-c");
    await route.fulfill({ contentType: "application/octet-stream", headers: { "X-Sample-Rate": "24000" }, body: Buffer.alloc(480) });
  });
  await page.route(`**/api/personas/${SLUG}/media`, async (route) => {
    const form = await multipart(route.request());
    attached.push([...form.keys()]);
    const voice = voices.find((candidate) => candidate.id === form.get("voiceId"));
    if (!voice) throw new Error("Expected a known voice ID");
    data.item.voice = { id: voice.id, name: voice.name };
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/personas/${SLUG}/edit?tab=media`);
  const section = voiceSection(page);
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator('input[value="shared-a"]')).toBeChecked();
  await expect(section.locator('input[value="shared-b"]')).not.toBeChecked();
  await expect(section.getByRole("button", { name: "Save voice", exact: true })).toBeDisabled();
  await section.getByRole("button", { name: "Listen to Jules", exact: true }).click();
  await expect.poll(() => previews).toBe(1);
  expect(attached).toHaveLength(0);
  await section.locator('input[value="sample-c"]').check();
  await section.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(attached).toHaveLength(0);
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator('input[value="shared-a"]')).toBeChecked();
  await section.locator('input[value="shared-b"]').check();
  await section.getByRole("button", { name: "Save voice", exact: true }).click();
  await expect.poll(() => attached.length).toBe(1);
  expect(attached).toEqual([["voiceId"]]);
  expect(created).toBe(0);
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator('input[value="shared-b"]')).toBeChecked();
  await expect(section.getByRole("button", { name: "Save voice", exact: true })).toBeDisabled();
});

test("own-persona editing preserves an unavailable current voice and never submits video", async ({ page }) => {
  const data = personaData(true, { id: "unavailable", name: "Original trainer recording" });
  await mockQuery(page, "page.personaEdit", () => data);
  const fields: string[][] = [];
  await page.route(`**/api/personas/${SLUG}/media`, async (route) => {
    const form = await multipart(route.request());
    fields.push([...form.keys()]);
    expect(form.get("voiceId")).toBe("sample-c");
    data.item.voice = { id: "sample-c", name: "Jules" };
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/personas/${SLUG}/edit?tab=media`);
  const section = voiceSection(page);
  await expect(section).toContainText("Original trainer recording");
  await expect(section).toContainText("It stays selected until you save another voice.");
  await expect(page.getByLabel("Photo", { exact: true })).toHaveCount(0);
  await expect(page.getByText("You can still record your voice there.", { exact: false })).toBeVisible();
  await section.getByRole("button", { name: "Choose a voice", exact: true }).click();
  await expect(section.locator('input[type="radio"]:checked')).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Save voice", exact: true })).toBeDisabled();
  await section.locator('input[value="sample-c"]').check();
  await section.getByRole("button", { name: "Save voice", exact: true }).click();
  await expect(section).toContainText("Current voice: Jules");
  expect(fields).toEqual([["voiceId"]]);
});

test("named upload has no assumed transcript, Cancel does nothing, and attachment retry does not upload twice", async ({ page }) => {
  const data = personaData();
  await mockQuery(page, "page.personaEdit", () => data);
  const uploads: { name: FormDataEntryValue | null; transcript: FormDataEntryValue | null; audioSize: number; filename: string; mime: string }[] = [];
  let attachments = 0;
  await page.route("**/api/tts/voices", async (route) => {
    const form = await multipart(route.request());
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new Error("Expected a recording upload");
    uploads.push({ name: form.get("name"), transcript: form.get("transcript"), audioSize: audio.size, filename: audio.name, mime: audio.type });
    await route.fulfill({ json: { voice: { id: "uploaded", name: "My recording", status: "ready" } } });
  });
  await page.route(`**/api/personas/${SLUG}/media`, async (route) => {
    attachments++;
    const form = await multipart(route.request());
    expect([...form.keys()]).toEqual(["voiceId"]);
    expect(form.get("voiceId")).toBe("uploaded");
    if (attachments === 1) {
      await route.fulfill({ status: 409, json: { error: "The voice changed while saving. Try again." } });
      return;
    }
    data.item.voice = { id: "uploaded", name: "My recording" };
    data.voices = [...voices, { id: "uploaded", name: "My recording", kind: "cloned" }];
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/personas/${SLUG}/edit?tab=media`);
  const section = voiceSection(page);
  await section.getByRole("button", { name: "Add my voice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add my voice", exact: true });
  await dialog.getByLabel("Voice name", { exact: true }).fill("Discarded recording");
  await dialog.getByRole("tab", { name: "Upload", exact: true }).click();
  const recording = { name: "original-clip.webm", mimeType: "audio/webm", buffer: Buffer.from("voice-ui-recording") };
  await dialog.getByLabel("Recording", { exact: true }).setInputFiles(recording);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(uploads).toHaveLength(0);
  expect(attachments).toBe(0);
  await section.getByRole("button", { name: "Add my voice", exact: true }).click();
  await expect(dialog.getByLabel("Voice name", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Voice name", { exact: true }).fill("My recording");
  await dialog.getByRole("tab", { name: "Upload", exact: true }).click();
  await dialog.getByLabel("Recording", { exact: true }).setInputFiles(recording);
  await dialog.getByRole("button", { name: "Save voice", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The voice changed while saving. Try again.");
  await expect(dialog).toContainText("without another upload");
  await dialog.getByRole("button", { name: "Save voice", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(section).toContainText("Current voice: My recording");
  expect(uploads).toEqual([{ name: "My recording", transcript: "", audioSize: recording.buffer.length, filename: recording.name, mime: recording.mimeType }]);
  expect(attachments).toBe(2);
});

test("voice rename is explicit and in-use deletion leaves the voice visible with the server's explanation", async ({ page }) => {
  const row = { id: "shared-a", name: "Shared voice", kind: "cloned", status: "ready", createdAt: "2026-11-19T00:00:00.000Z" };
  await mockQuery(page, "page.voices", () => ({ mine: [row], samples: [{ ...row, id: "sample-c", name: "Jules", kind: "sample" }] }));
  const renames: { name: string }[] = [];
  await page.route("**/api/tts/voices/shared-a", async (route) => {
    if (route.request().method() === "PATCH") {
      const body: { name: string } = route.request().postDataJSON();
      renames.push(body);
      row.name = body.name;
      await route.fulfill({ json: { voice: { id: row.id, name: row.name } } });
      return;
    }
    await route.fulfill({ status: 409, json: { error: "That voice is in use and cannot be deleted.", code: "voice_in_use" } });
  });
  await page.goto("/voice");
  await page.getByRole("button", { name: "Actions for Shared voice", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename voice", exact: true });
  await rename.getByLabel("Voice name", { exact: true }).fill("Discarded name");
  await rename.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(renames).toHaveLength(0);
  await page.getByRole("button", { name: "Actions for Shared voice", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(rename.getByLabel("Voice name", { exact: true })).toHaveValue("Shared voice");
  await rename.getByLabel("Voice name", { exact: true }).fill("Shared recording");
  await rename.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(rename).toBeHidden();
  expect(renames).toEqual([{ name: "Shared recording" }]);
  await page.getByRole("button", { name: "Actions for Shared recording", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const remove = page.getByRole("alertdialog", { name: "Delete Shared recording?", exact: true });
  await remove.getByRole("textbox").fill("Shared recording");
  await remove.getByRole("button", { name: "Delete voice", exact: true }).click();
  await expect(remove.getByRole("alert")).toHaveText("That voice is in use and cannot be deleted.");
  await remove.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("link", { name: /Shared recording/ })).toBeVisible();
  await page.getByRole("tab", { name: "Explore voices", exact: true }).click();
  await expect(page.getByRole("button", { name: "Listen to Jules", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Actions for Jules", exact: true })).toHaveCount(0);
});

test("incomplete removal disables playback and rename, survives reload, and can be retried", async ({ page }) => {
  const row = { id: "retry-voice", name: "Retry recording", kind: "cloned", status: "ready", createdAt: "2026-11-19T00:00:00.000Z" };
  let removed = false;
  let attempts = 0;
  await mockQuery(page, "page.voices", () => ({ mine: removed ? [] : [row], samples: [] }));
  await page.route("**/api/tts/voices/retry-voice", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    attempts++;
    if (attempts === 1) {
      row.status = "deleting";
      await route.fulfill({ status: 503, json: {
        error: "Voice deletion could not finish. Retry deleting this voice.", code: "voice_delete_retryable",
      } });
      return;
    }
    removed = true;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/voice");
  await page.getByRole("button", { name: "Actions for Retry recording", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Retry recording?", exact: true });
  await dialog.getByRole("textbox").fill(row.name);
  await dialog.getByRole("button", { name: "Delete voice", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Voice deletion could not finish. Retry deleting this voice.");
  await expect(dialog.getByRole("button", { name: "Retry delete", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Removal incomplete", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Listen to Retry recording", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText("Removal incomplete", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Listen to Retry recording", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Retry recording/ })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Actions for Retry recording", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Retry delete", exact: true }).click();
  await dialog.getByRole("textbox").fill(row.name);
  await dialog.getByRole("button", { name: "Retry delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Actions for Retry recording", exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
});
});
