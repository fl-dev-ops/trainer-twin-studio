/**
 * Benchmark VoxCPM2 TTS concurrency & streaming latency.
 * Tests progressive concurrent streams to find the saturation knee.
 */

const ENDPOINT = process.env.TTS_SERVICE_URL
  ? `${process.env.TTS_SERVICE_URL.replace(/\/$/, "")}/v1/audio/speech`
  : "https://tts.trainertwin.com/v1/audio/speech";
const API_KEY = process.env.TTS_APP_KEY || process.env.TTS_API_KEY || "";
const VOICE = "cmtl8nn7x0004i9sevdlbb03n";

// Realistic interview questions (~20-25 words)
const TEST_PROMPTS = [
  "Looking at your resume on screen, what was your starting baseline before you implemented Redis caching?",
  "Can you describe the architectural trade-offs you considered when choosing between Kafka and RabbitMQ for asynchronous jobs?",
  "How did you measure the forty percent latency reduction, and were there other factors influencing that measurement?",
  "Walk me through the database partitioning strategy you designed for high volume transactional workloads.",
  "When multiple services attempt concurrent updates to the same user balance, how do you prevent race conditions?",
  "Tell me about a specific production outage you handled and the steps you took to isolate the root cause.",
  "How did you ensure zero downtime deployment while migrating table schemas across active read replicas?",
  "Can you explain how your rate limiter handles burst traffic without dropping critical checkout requests?",
];

interface StreamResult {
  id: number;
  ok: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  audioDurationSec: number;
  rtf: number;
  error?: string;
}

async function runSingleStream(id: number, prompt: string): Promise<StreamResult> {
  const start = performance.now();
  let firstByteTime: number | null = null;
  let totalBytes = 0;
  let sampleRate = 48000;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "voxcpm2",
        voice: VOICE,
        input: prompt,
        stream: true,
        response_format: "pcm",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        id,
        ok: false,
        status: res.status,
        ttfbMs: performance.now() - start,
        totalMs: performance.now() - start,
        bytes: 0,
        audioDurationSec: 0,
        rtf: 0,
        error: `HTTP ${res.status}: ${errText.slice(0, 100)}`,
      };
    }

    const rateHeader = res.headers.get("x-sample-rate") || res.headers.get("x-audio-sample-rate");
    if (rateHeader) {
      const parsed = parseInt(rateHeader, 10);
      if (!isNaN(parsed) && parsed > 0) sampleRate = parsed;
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No readable stream in response");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        if (firstByteTime === null) {
          firstByteTime = performance.now();
        }
        totalBytes += value.length;
      }
    }

    const end = performance.now();
    const ttfbMs = firstByteTime ? firstByteTime - start : end - start;
    const totalMs = end - start;
    // 16-bit mono PCM = sampleRate * 2 bytes/sec
    const audioDurationSec = totalBytes / (sampleRate * 2);
    const rtf = totalMs > 0 ? audioDurationSec / (totalMs / 1000) : 0;

    return {
      id,
      ok: true,
      status: res.status,
      ttfbMs,
      totalMs,
      bytes: totalBytes,
      audioDurationSec,
      rtf,
    };
  } catch (err: any) {
    const elapsed = performance.now() - start;
    return {
      id,
      ok: false,
      status: 0,
      ttfbMs: elapsed,
      totalMs: elapsed,
      bytes: totalBytes,
      audioDurationSec: 0,
      rtf: 0,
      error: err.message,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[index];
}

async function runTier(concurrency: number): Promise<{
  concurrency: number;
  successCount: number;
  totalCount: number;
  p50Ttfb: number;
  p95Ttfb: number;
  p50Rtf: number;
  p95TotalSec: number;
  avgAudioDurationSec: number;
  errors: string[];
}> {
  process.stdout.write(`Testing Concurrency ${concurrency.toString().padStart(2)} ... `);
  const tasks: Promise<StreamResult>[] = [];
  for (let i = 0; i < concurrency; i++) {
    const prompt = TEST_PROMPTS[i % TEST_PROMPTS.length];
    tasks.push(runSingleStream(i, prompt));
  }

  const results = await Promise.all(tasks);
  const successful = results.filter((r) => r.ok);
  const errors = results.filter((r) => !r.ok).map((r) => r.error || "Unknown error");

  const ttfbs = successful.map((r) => r.ttfbMs).sort((a, b) => a - b);
  const totals = successful.map((r) => r.totalMs / 1000).sort((a, b) => a - b);
  const rtfs = successful.map((r) => r.rtf).sort((a, b) => a - b);
  const audioDurations = successful.map((r) => r.audioDurationSec);
  const avgAudioSec =
    audioDurations.length > 0
      ? audioDurations.reduce((a, b) => a + b, 0) / audioDurations.length
      : 0;

  const p50Ttfb = percentile(ttfbs, 50);
  const p95Ttfb = percentile(ttfbs, 95);
  const p50Rtf = percentile(rtfs, 50);
  const p95TotalSec = percentile(totals, 95);

  console.log(
    `Done. Success: ${successful.length}/${concurrency} | P50 TTFB: ${p50Ttfb.toFixed(0)}ms | P95 TTFB: ${p95Ttfb.toFixed(0)}ms | P50 RTF: ${p50Rtf.toFixed(2)}x`
  );

  return {
    concurrency,
    successCount: successful.length,
    totalCount: concurrency,
    p50Ttfb,
    p95Ttfb,
    p50Rtf,
    p95TotalSec,
    avgAudioDurationSec: avgAudioSec,
    errors,
  };
}

async function main() {
  console.log("================================================================================");
  console.log("               VOXCPM2 TTS CONCURRENCY & STREAMING BENCHMARK                    ");
  console.log("================================================================================");
  console.log(`Endpoint:    ${ENDPOINT}`);
  console.log(`Voice ID:    ${VOICE}`);
  console.log(`Audio:       16-bit PCM @ 48kHz mono (96 kB/s)`);
  console.log("--------------------------------------------------------------------------------");

  // Concurrency stepping
  const TIERS = [1, 2, 4, 6, 8, 12, 16, 20];
  const summary: Awaited<ReturnType<typeof runTier>>[] = [];

  for (const c of TIERS) {
    const tierResult = await runTier(c);
    summary.push(tierResult);
    // 2-second cool-down between tiers so GPU memory and buffers stabilize
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log("\n================================================================================");
  console.log("                              BENCHMARK RESULTS                                 ");
  console.log("================================================================================");
  console.log(
    "| Concurrency | Success | P50 TTFB  | P95 TTFB  | P50 RTF | P95 Total | Health / Saturation |"
  );
  console.log(
    "|------------:|--------:|----------:|----------:|--------:|----------:|:--------------------|"
  );

  let saturationFound = false;
  let recommendedMax = 1;

  for (const s of summary) {
    const successRate = `${Math.round((s.successCount / s.totalCount) * 100)}%`;
    const p50TtfbStr = `${s.p50Ttfb.toFixed(0)} ms`;
    const p95TtfbStr = `${s.p95Ttfb.toFixed(0)} ms`;
    const p50RtfStr = `${s.p50Rtf.toFixed(2)}x`;
    const p95TotalStr = `${s.p95TotalSec.toFixed(1)} s`;

    let status = "Optimal (< 1.5s TTFB)";
    if (s.successCount < s.totalCount) {
      status = "DROPOUTS / ERRORS";
      saturationFound = true;
    } else if (s.p50Rtf < 1.0) {
      status = "BUFFER UNDERRUN (RTF < 1x)";
      saturationFound = true;
    } else if (s.p50Ttfb > 3000 || s.p95Ttfb > 4500) {
      status = "HIGH LATENCY (Degraded)";
      saturationFound = true;
    } else if (s.p50Ttfb > 1800) {
      status = "Queuing Delay Noticeable";
      if (!saturationFound) recommendedMax = s.concurrency;
    } else {
      recommendedMax = s.concurrency;
    }

    console.log(
      `| ${s.concurrency.toString().padStart(11)} | ${successRate.padStart(7)} | ${p50TtfbStr.padStart(9)} | ${p95TtfbStr.padStart(9)} | ${p50RtfStr.padStart(7)} | ${p95TotalStr.padStart(9)} | ${status.padEnd(19)} |`
    );
  }

  console.log("================================================================================");
  console.log(`\nANALYSIS & CAPACITY CEILING:`);
  console.log(`- Recommended Max Concurrent Streams: ${recommendedMax}`);
  console.log(
    `- RTF threshold: Must remain > 1.0x so audio streams faster than it plays aloud.`
  );
  console.log(
    `- TTFB threshold: For voice agent conversational turns, P50 TTFB under 1.5s is acceptable, under 1.0s is optimal.`
  );
}

main().catch(console.error);
