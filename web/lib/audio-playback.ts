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

/** Consume a /api/tts/speech response (raw 16-bit PCM) and play it live. */
export async function playPcmStream(response: Response): Promise<void> {
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `TTS failed (${response.status})`);
  }
  const context = getSharedAudioContext();
  const sampleRate = Number(response.headers.get("X-Sample-Rate")) || 24000;
  let nextTime = context.currentTime + 0.05;

  const reader = response.body.getReader();
  let pending = new Int16Array(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const incoming = new Int16Array(value.buffer, value.byteOffset, value.byteLength / 2);
    const merged = new Int16Array(pending.length + incoming.length);
    merged.set(pending);
    merged.set(incoming, pending.length);

    const sliceSize = Math.floor(sampleRate * 0.2);
    let offset = 0;
    while (merged.length - offset >= sliceSize) {
      const buffer = context.createBuffer(1, sliceSize, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < sliceSize; i++) channel[i] = merged[offset + i] / 32767;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => liveSources.delete(source);
      liveSources.add(source);
      nextTime = Math.max(nextTime, context.currentTime + 0.02);
      source.start(nextTime);
      nextTime += buffer.duration;
      offset += sliceSize;
    }
    pending = merged.slice(offset);
  }
}

export async function generateSpeech(voice: string, input: string, stream = true): Promise<Response> {
  return fetch("/api/tts/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice, input, stream, response_format: stream ? "pcm" : "wav" }),
  });
}
