---
name: clone-voice-from-wav
description: Register a cloned TTS voice from a .wav recording in the trainer-twin-studio Demo org. Uploads the clip to S3, creates the Voice row in the DB and returns the voice_id. Use when someone says "clone this voice", "register a voice from this wav", or "give me a voice_id for this audio".
---

# Clone a voice from a .wav file

**Output:** the new `voice_id` (the `Voice.id` cuid, e.g. `cmv6eccxg00002sesxltt8xvn`). Nothing else counts as done.

Cloning is zero-shot. The TTS (VoxCPM2) uses the uploaded clip as its reference at synthesis time. No training runs, so registering the clip *is* the clone.

## Inputs (ask for any that are missing; don't guess)

| Input | Notes |
| --- | --- |
| Path to the `.wav` file | Required. Must be non-empty and under 25 MB. |
| Voice name | Required, e.g. `Prathosh A P`. A display name only. Duplicates are allowed because the ID is a cuid. |
| Transcript `.txt` | Optional. Leave it out unless the user provides one. |

Target org: **Demo**, `4a5c5ac2-c5ff-460e-b9be-e5cc94e54c3b`. Use a different org only if the user names one.

## Prerequisites

1. Clone the repo and install dependencies (it uses bun, per `bun.lock`):
   ```bash
   git clone https://github.com/fl-dev-ops/trainer-twin-studio.git
   cd trainer-twin-studio/web && bun install
   ```
2. `trainer-twin-studio/web/.env` must define `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `S3_BUCKET` (or `AWS_S3_BUCKET`). `S3_BASE_PREFIX` is optional and defaults to `trainertwin-dev`.
   - **The user sets these values themselves.** Never ask them to paste keys into chat. Never print, log or commit `.env`. If a variable is missing, name it and stop.
3. If `web/scripts/register-voice.ts` doesn't exist, create it with the exact contents in [The register-voice script](#the-register-voice-script) below. It isn't committed to the repo. It only uses the repo's existing `lib/db` (Prisma) and `lib/s3` helpers, so no new dependencies are needed.

## Steps

1. **Check the audio** (requires ffprobe):
   ```bash
   ffprobe -v error -show_entries format=duration,size:stream=codec_name,sample_rate,channels -of default=nw=1 "<file.wav>"
   ```
   - It must be WAV audio and smaller than 25 MB.
   - For a good clone, use 10–20 s of a single speaker with no music or noise. If the clip is long or noisy, tell the user and ask whether to continue or have them supply a cleaner clip. Don't trim or denoise without asking.
2. **Register** from `trainer-twin-studio/web`:
   ```bash
   bun run scripts/register-voice.ts --org 4a5c5ac2-c5ff-460e-b9be-e5cc94e54c3b --name "<Voice name>" --audio "<file.wav>"
   ```
   Add `--transcript "<file.txt>"` only if the user provided a transcript. The script:
   - checks that the org exists and creates a `Voice` row,
   - uploads `<prefix>/<orgId>/tts-voices/<voiceId>/reference.wav`, logged as `[EXT-API:s3-voice-upload] start/done`,
   - updates the row with the S3 key, then prints JSON.

   If the upload fails, the script deletes the row itself, so no orphan is left.
3. **Read the result.** Success prints:
   ```json
   { "voice": { "id": "<voice_id>", "name": "...", "status": "ready", "s3AudioKey": ".../reference.wav", "s3TranscriptKey": null } }
   ```
   Check that `status` is `ready` and that `s3AudioKey` ends in `reference.wav`.
4. **Report** to the user:
   ```
   voice_id: <voice_id>
   name: <name> · org: Demo · status: ready
   ```

## Failures: report them, don't work around them

| Message | Meaning / action |
| --- | --- |
| `S3 is not configured` | The S3 env vars are missing. Ask the user to add them. |
| `organization not found` | Wrong org ID or wrong `DATABASE_URL`. Confirm with the user. |
| `audio must be non-empty and under 25 MB` | Ask for a smaller or shorter clip. |
| `[EXT-API:s3-voice-upload] failed` | AWS credentials, bucket or network problem. Report the error summary without credentials. The row was already rolled back. |
| Prisma connection error | `DATABASE_URL` is unreachable. Report it. |

If two materially different attempts fail, stop and report the blocker. Don't retry in a loop.

## Using the voice_id

- Agent profiles that use VoxCPM2 take this ID as their voice, e.g. intervoo-agents `config/agents.json`.
- To hear it, synthesize through the studio TTS endpoint with this `voice_id`. Listening is a separate step. The user judges the likeness, not the agent.

## The register-voice script

Save as `trainer-twin-studio/web/scripts/register-voice.ts`:

```ts
// Register a cloned TTS voice from a local reference recording, mirroring POST /api/tts/voices
// without needing a signed-in dashboard session.
// Usage: bun run scripts/register-voice.ts --org <orgId> --name "<name>" --audio <file.wav> [--transcript <file.txt>]
import { readFileSync } from "node:fs";
import { db } from "../lib/db";
import { putObject, s3Configured, voicePrefix } from "../lib/s3";

const arg = (flag: string) => process.argv.find((_, i, arr) => arr[i - 1] === flag);
const orgId = arg("--org");
const name = arg("--name")?.trim();
const audioPath = arg("--audio");
const transcriptPath = arg("--transcript");

if (!orgId || !name || !audioPath) {
  console.error('Usage: bun run scripts/register-voice.ts --org <orgId> --name "<name>" --audio <file.wav> [--transcript <file.txt>]');
  process.exit(1);
}
if (!s3Configured) {
  console.error("S3 is not configured (S3_BUCKET / AWS_ACCESS_KEY_ID)");
  process.exit(1);
}

const audio = new Uint8Array(readFileSync(audioPath));
if (audio.length === 0 || audio.length > 25 * 1024 * 1024) {
  console.error("audio must be non-empty and under 25 MB");
  process.exit(1);
}
const transcript = transcriptPath ? readFileSync(transcriptPath, "utf-8").trim() : "";

const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } });
if (!org) {
  console.error(`organization not found: ${orgId}`);
  process.exit(1);
}

const voice = await db.voice.create({ data: { orgId, name, s3AudioKey: "" } });
const prefix = voicePrefix(orgId, voice.id);

const started = Date.now();
console.log(`[EXT-API:s3-voice-upload] start voice=${voice.id} bytes=${audio.length}`);
try {
  await putObject(`${prefix}/reference.wav`, audio, "audio/wav");
  if (transcript) await putObject(`${prefix}/transcript.txt`, transcript, "text/plain");
} catch (error) {
  console.error(`[EXT-API:s3-voice-upload] failed voice=${voice.id} elapsed_ms=${Date.now() - started}`, error);
  await db.voice.delete({ where: { id: voice.id } });
  process.exit(1);
}
console.log(`[EXT-API:s3-voice-upload] done voice=${voice.id} elapsed_ms=${Date.now() - started}`);

const updated = await db.voice.update({
  where: { id: voice.id },
  data: { s3AudioKey: `${prefix}/reference.wav`, s3TranscriptKey: transcript ? `${prefix}/transcript.txt` : null },
  select: { id: true, name: true, status: true, s3AudioKey: true, s3TranscriptKey: true },
});
console.log(JSON.stringify({ voice: updated }, null, 2));
await db.$disconnect();
```
