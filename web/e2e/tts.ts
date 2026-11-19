import { createServer } from "node:http";
import { z } from "zod";
import { E2E_PORT } from "./env";

const speech = z.object({
  voice: z.string().min(1),
  input: z.string().min(1),
  response_format: z.enum(["wav", "pcm"]).default("pcm"),
  stream: z.boolean().optional(),
  model: z.string().optional(),
});
const metadata = z.object({ audioUrl: z.string().url(), transcript: z.string().nullable(), version: z.string() });

function audio(format: "pcm" | "wav") {
  const rate = 24_000;
  const pcm = Buffer.alloc(rate);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 2048), i * 2);
  if (format === "pcm") return pcm;
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

/** Synthetic audio replaces only inference; app authorization, voice resolution and object reads stay real. */
createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== "Bearer e2e-tts-service") { response.writeHead(401).end(); return; }
    if (request.method !== "POST" || request.url !== "/v1/audio/speech") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = speech.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
    if (!body.success) { response.writeHead(400).end(JSON.stringify({ error: "Invalid test speech request" })); return; }
    const resolved = await fetch(`http://localhost:${E2E_PORT}/api/tts/voices/${encodeURIComponent(body.data.voice)}`, {
      headers: { authorization: "Bearer e2e-tts-app" },
    });
    if (!resolved.ok) { response.writeHead(resolved.status).end(JSON.stringify({ error: "Local voice resolution failed" })); return; }
    const voice = metadata.parse(await resolved.json());
    const reference = new URL(voice.audioUrl);
    if (reference.origin !== "http://127.0.0.1:9100" || !reference.pathname.startsWith("/olga-local/voice-e2e/")) {
      throw new Error("Refusing non-isolated voice reference in browser tests");
    }
    const original = await fetch(reference);
    if (!original.ok || !(await original.arrayBuffer()).byteLength) throw new Error("Test voice reference is unavailable");
    response.writeHead(200, {
      "content-type": body.data.response_format === "pcm" ? "audio/pcm" : "audio/wav",
      "x-sample-rate": "24000",
    });
    response.end(audio(body.data.response_format));
  } catch (error) {
    console.error("Local speech fixture failed", error);
    response.writeHead(500).end(JSON.stringify({ error: "Local speech fixture failed" }));
  }
}).listen(3997, "127.0.0.1");
