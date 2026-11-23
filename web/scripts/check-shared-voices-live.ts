import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { z } from "zod";
import { assertRestoreEnvironment } from "./restore-olga-local-skills";

const ORG = "bc657406-6209-4bb8-af6f-c0d8141a17a4";
const PRIVATE = resolve(import.meta.dir, "../../backups/olga-local");
const WEB = "http://localhost:3100";
const text = "This is a local voice sharing check. The same voice can be used by more than one persona.";

function inspectPcm(bytes: Uint8Array, sampleRate: number) {
  if (!bytes.length || bytes.length % 2 || !Number.isInteger(sampleRate) || sampleRate < 8000) throw new Error("Invalid PCM audio");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let squares = 0;
  let peak = 0;
  for (let i = 0; i < bytes.byteLength; i += 2) {
    const value = data.getInt16(i, true) / 32768;
    squares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const duration = bytes.length / (sampleRate * 2);
  const rms = Math.sqrt(squares / (bytes.length / 2));
  if (duration < 0.5 || duration > 90 || rms < 0.0001) throw new Error("Empty, silent or unexpectedly sized speech");
  return { duration, rms, peak, sampleRate, bytes: bytes.length };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--verify") throw new Error("Requires --verify; invokes the explicitly approved production TTS service");
  assertRestoreEnvironment(process.env);
  const tts = new URL(process.env.TTS_SERVICE_URL ?? "");
  if (tts.origin !== "https://tts.trainertwin.com" || tts.pathname !== "/") throw new Error("Only the approved TTS endpoint is allowed");
  if (!process.env.TTS_APP_KEY) throw new Error("TTS resolver credential is missing");
  process.umask(0o077);
  const auth = z.object({ cookieHeader: z.string().min(1) }).parse(
    JSON.parse(await readFile(resolve(PRIVATE, "private-admin-authstate.json"), "utf8")),
  );
  const baseline = z.object({
    database: z.literal("trainertwin_olga_local"),
    rows: z.object({ Voice: z.array(z.object({ id: z.string() })) }),
  }).parse(JSON.parse(await readFile(resolve(PRIVATE, "private-voice-phase-baseline.json"), "utf8")));
  const session = await fetch(`${WEB}/api/auth/get-session`, { headers: { cookie: auth.cookieHeader }, signal: AbortSignal.timeout(30_000) });
  if (!session.ok) throw new Error("Local administrator authentication failed");
  const user = z.object({ user: z.object({ id: z.literal("olga-local-admin") }) }).parse(await session.json());
  void user;
  const client = new Client({
    host: "/tmp", database: "trainertwin_olga_local", options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS db, current_setting('transaction_read_only') AS ro, inet_server_addr() AS address");
    if (identity.rows[0].db !== "trainertwin_olga_local" || identity.rows[0].ro !== "on" || identity.rows[0].address !== null) throw new Error("Local database identity failed");
    const result = await client.query<{ id: string; name: string }>(
      'SELECT v.id,v.name FROM "Voice" v JOIN "Persona" p ON p."voiceId"=v.id WHERE p."orgId"=$1 AND v.id=ANY($2::text[]) ORDER BY p."isOwn" DESC,v.id LIMIT 2',
      [ORG, baseline.rows.Voice.map((voice) => voice.id)],
    );
    if (result.rows.length !== 2 || result.rows[0].id === result.rows[1].id) throw new Error("Two original local voices are required");
    const unauthorized = await fetch(`${WEB}/api/tts/speech`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: result.rows[0].id, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (unauthorized.status !== 401) throw new Error(`Anonymous speech was not refused: ${unauthorized.status}`);
    const checks = [];
    for (const [index, voice] of [result.rows[0], result.rows[1], result.rows[0]].entries()) {
      const resolved = await fetch(`${WEB}/api/tts/voices/${encodeURIComponent(voice.id)}`, {
        headers: { authorization: `Bearer ${process.env.TTS_APP_KEY}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resolved.ok) throw new Error(`Local voice metadata failed: ${resolved.status}`);
      const metadata = z.object({ audioUrl: z.string().url(), version: z.string() }).parse(await resolved.json());
      const reference = new URL(metadata.audioUrl);
      if (reference.origin !== "http://127.0.0.1:9100" || !reference.pathname.startsWith("/olga-local/")) throw new Error("Voice metadata escaped local storage");
      const stream = index === 2;
      const started = performance.now();
      const response = await fetch(`${WEB}/api/tts/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json", cookie: auth.cookieHeader,
          origin: `https://dash.${process.env.NEXT_PUBLIC_BASE_DOMAIN}:8443`,
        },
        body: JSON.stringify({ voice: voice.id, input: text, stream, response_format: stream ? "pcm" : "wav" }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`Approved speech request failed: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let sampleRate = Number(response.headers.get("x-sample-rate"));
      let pcm = bytes;
      if (!stream) {
        const buffer = Buffer.from(bytes);
        if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE"
          || buffer.readUInt16LE(20) !== 1 || buffer.readUInt16LE(22) !== 1 || buffer.readUInt16LE(34) !== 16) {
          throw new Error("Expected mono PCM16 WAV speech");
        }
        sampleRate = buffer.readUInt32LE(24);
        let offset = 12;
        let found = false;
        while (offset + 8 <= bytes.length) {
          const size = buffer.readUInt32LE(offset + 4);
          if (buffer.toString("ascii", offset, offset + 4) === "data") {
            pcm = bytes.subarray(offset + 8, offset + 8 + size);
            found = true;
            break;
          }
          offset += 8 + size + (size % 2);
        }
        if (!found) throw new Error("WAV data chunk is missing");
      }
      const metrics = inspectPcm(pcm, sampleRate);
      const filename = `private-voice-live-${index + 1}.${stream ? "pcm" : "wav"}`;
      const path = resolve(PRIVATE, filename);
      await writeFile(path, bytes, { mode: 0o600 });
      await chmod(path, 0o600);
      checks.push({ voiceId: voice.id, stream, status: response.status, elapsedMs: Math.round(performance.now() - started), ...metrics });
    }
    const report = {
      endpoint: tts.origin, localDatabase: "trainertwin_olga_local", anonymousStatus: unauthorized.status,
      checks, newlyUploadedLocalVoices: "Inference covered by local provider fixture; production resolver does not know local-only IDs",
    };
    const path = resolve(PRIVATE, "private-voice-live-report.json");
    await writeFile(path, JSON.stringify(report), { mode: 0o600 });
    await chmod(path, 0o600);
    console.log(JSON.stringify({ requests: checks.length, distinctVoices: 2, streamed: 1, wav: 2, nonSilent: true }));
  } finally {
    await client.end();
  }
}

if (import.meta.main) await main();
