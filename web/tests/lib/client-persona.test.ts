import assert from "node:assert/strict";
import test from "node:test";
import {
  SCRATCH_LOOK,
  clientPersonaSchema,
  formFromPersonaData,
  personaDataFromForm,
  presetForm,
  scratchForm,
} from "../../lib/client-persona";

const PHOTO = "/api/client-persona-photos/org_123/0b6f3c3e-8a51-4f0e-9d7a-2a1d6b8f9c10.jpg";

test("a preset persona keeps its preset photo", () => {
  const form = clientPersonaSchema.parse(presetForm("priya"));
  assert.equal(personaDataFromForm(form).avatar, "/roleplay/avatars/priya.jpg");
});

test("a persona from scratch stores the uploaded photo and a free-text role", () => {
  const form = clientPersonaSchema.parse({ ...scratchForm(), name: "Dana Cole", role: "Head of Sales", photo: PHOTO });
  const data = personaDataFromForm(form);
  assert.equal(data.avatar, PHOTO);
  assert.equal(data.role, "Head of Sales");
  assert.equal(data.look, SCRATCH_LOOK);

  const back = formFromPersonaData(data);
  assert.equal(back.look, SCRATCH_LOOK);
  assert.equal(back.photo, PHOTO);
});

test("switching a preset persona to scratch without a photo drops the preset photo", () => {
  const existing = personaDataFromForm(clientPersonaSchema.parse(presetForm("daniel")));
  const form = clientPersonaSchema.parse({ ...scratchForm(), name: "Sam", role: "Hiring manager" });
  assert.equal(personaDataFromForm(form, existing).avatar, undefined);
});

test("only uploaded photo URLs are accepted", () => {
  const bad = clientPersonaSchema.safeParse({ ...scratchForm(), name: "X", role: "Buyer", photo: "https://evil.example/x.jpg" });
  assert.equal(bad.success, false);
});

test("a role is required", () => {
  const result = clientPersonaSchema.safeParse({ ...scratchForm(), name: "X" });
  assert.equal(result.success, false);
});
