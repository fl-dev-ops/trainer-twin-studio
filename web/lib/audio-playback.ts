"use client";

/** Shared audio-context + streamed-PCM playback used by every TTS surface. */

let sharedContext: AudioContext | null = null;
const liveSources = new Set<AudioBufferSourceNode>();

export function getSharedAudioContext(): AudioContext {
  sharedContext ??= new AudioContext();
  void sharedContext.resume();
  return sharedContext;
}

/** Stop every currently scheduled/playing TTS buffer. */
export function stopPlayback() {
  for (const source of liveSources) {
    try { source.stop(); } catch { /* already ended */ }
  }
  liveSources.clear();
}

/**
 * Splits streamed 16-bit PCM into whole slices of `sliceSamples` samples. Network chunks can end mid-sample (an odd
 * byte), so bytes are carried over until a sample is complete; reading each chunk on its own shifted every later
 * sample by a byte (loud static). `final` also returns the remainder shorter than a slice (the end of the audio).
 */
export function splitPcm(carry: Uint8Array, chunk: Uint8Array, sliceSamples: number, final = false): { slices: Int16Array[]; carry: Uint8Array } {
  const bytes = new Uint8Array(carry.length + chunk.length);
  bytes.set(carry);
  bytes.set(chunk, carry.length);
  const sliceBytes = sliceSamples * 2;
  const slices: Int16Array[] = [];
  let offset = 0;
  while (bytes.length - offset >= sliceBytes) {
    // slice() copies into a fresh buffer: aligned for Int16Array whatever the source offset.
    slices.push(new Int16Array(bytes.slice(offset, offset + sliceBytes).buffer));
    offset += sliceBytes;
  }
  const whole = (bytes.length - offset) & ~1;
  if (final && whole > 0) {
    slices.push(new Int16Array(bytes.slice(offset, offset + whole).buffer));
    offset += whole;
  }
  return { slices, carry: bytes.slice(offset) };
}

/** Consume a /api/tts/speech response (raw 16-bit PCM) and play it live. */
export async function playPcmStream(response: Response): Promise<void> {
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `TTS failed (${response.status})`);
  }
  const context = getSharedAudioContext();
  const sampleRate = Number(response.headers.get("X-Sample-Rate")) || 24000;
  const sliceSamples = Math.floor(sampleRate * 0.2);
  let nextTime = context.currentTime + 0.05;

  function schedule(samples: Int16Array) {
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => liveSources.delete(source);
    liveSources.add(source);
    nextTime = Math.max(nextTime, context.currentTime + 0.02);
    source.start(nextTime);
    nextTime += buffer.duration;
  }

  const reader = response.body.getReader();
  let carry: Uint8Array = new Uint8Array(0);
  while (true) {
    const { done, value } = await reader.read();
    const next = splitPcm(carry, value ?? new Uint8Array(0), sliceSamples, done);
    next.slices.forEach(schedule);
    carry = next.carry;
    if (done) break;
  }
}

export async function generateSpeech(voice: string, input: string, stream = true): Promise<Response> {
  return fetch("/api/tts/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice, input, stream, response_format: stream ? "pcm" : "wav" }),
  });
}
