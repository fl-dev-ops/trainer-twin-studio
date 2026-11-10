"""End-to-end TTS acceptance benchmark: contract checks, interleaved latency tiers,
simulated playback stalls, capacity tiers and a soak. Keys come from env vars.

    python scripts/benchmark_tts.py --target aws=https://a.example=AWS_KEY \
        --target jl=https://b.example=JL_KEY --voice <id> --out results/
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import struct
import time
from pathlib import Path

import httpx

RATE = 48000
BPS = RATE * 2
PROMPTS = [
    "Looking at your resume on screen, what was your starting baseline before you implemented Redis caching?",
    "Can you describe the architectural trade-offs you considered when choosing between Kafka and RabbitMQ for asynchronous jobs?",
    "How did you measure the forty percent latency reduction, and were there other factors influencing that measurement?",
    "Walk me through the database partitioning strategy you designed for high volume transactional workloads.",
    "Good. Let's move on.",
    "When multiple services attempt concurrent updates to the same user balance, how do you prevent race conditions?",
]
LONG = (
    "Thanks for walking me through that design. I want to dig into a few details before we move on. "
    "First, tell me how you decided on the partition key, and what happens when one tenant becomes much larger than the rest. "
    "Second, explain how you would roll out a schema change across active read replicas without downtime, "
    "and how you would verify that nothing regressed. Finally, if you had to cut the infrastructure cost in half next quarter, "
    "which parts of this system would you simplify first, and which would you protect?"
)


def pct(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p) - 1)] if values else None


def summarize(rows):
    good = [r for r in rows if r["ok"]]
    out = {"requests": len(rows), "success": len(good), "errors": sorted({r.get("error") for r in rows if not r["ok"]})}
    for key in ("ttfa_ms", "total_ms", "rtf", "stall_ms", "max_gap_ms"):
        vals = [r[key] for r in good]
        out[key] = {"p50": statistics.median(vals) if vals else None, "p95": pct(vals, .95), "max": max(vals, default=None)}
    out["stalled_requests"] = sum(r["stall_ms"] > 0 for r in good)
    return out


async def speak(client, voice, text, sample=None):
    """Stream one utterance; simulate a player that starts at first byte."""
    start = time.perf_counter()
    first = prev = None
    size = gap = stall = 0.0
    buffered_until = 0.0
    energy = 0
    audio = bytearray()
    try:
        async with client.stream("POST", "/v1/audio/speech", json={
            "model": "voxcpm2", "voice": voice, "input": text, "stream": True, "response_format": "pcm",
        }) as r:
            if r.status_code != 200:
                return {"ok": False, "error": f"HTTP {r.status_code}"}
            if int(r.headers.get("x-sample-rate", RATE)) != RATE:
                return {"ok": False, "error": "sample-rate"}
            async for part in r.aiter_bytes():
                if not part:
                    continue
                now = time.perf_counter()
                if first is None:
                    first = buffered_until = now
                if prev is not None:
                    gap = max(gap, now - prev)
                if now > buffered_until:  # player ran dry before this chunk arrived
                    stall += now - buffered_until
                    buffered_until = now
                buffered_until += len(part) / BPS
                prev = now
                size += len(part)
                audio.extend(part)
                if size > BPS * 180:
                    return {"ok": False, "error": "too-long"}
        total = time.perf_counter() - start
        if first is None or size < 960 or len(audio) % 2:
            return {"ok": False, "error": "invalid-pcm"}
        samples = struct.unpack(f"<{len(audio) // 2}h", audio)
        energy = math.sqrt(sum(s * s for s in samples[::50]) / max(1, len(samples[::50])))
        if energy < 30:
            return {"ok": False, "error": "silent"}
        if sample:
            sample.write_bytes(audio)
        seconds = size / BPS
        return {"ok": True, "ttfa_ms": (first - start) * 1000, "total_ms": total * 1000, "audio_s": seconds,
                "rtf": total / seconds, "stall_ms": stall * 1000, "max_gap_ms": gap * 1000, "rms": energy}
    except httpx.HTTPError as exc:
        return {"ok": False, "error": type(exc).__name__}


async def contract(name, client, voice, out):
    """Functional checks that must hold on any production endpoint."""
    checks = {}
    async with httpx.AsyncClient(base_url=client.base_url, timeout=30) as anon:
        r = await anon.post("/v1/audio/speech", json={"voice": voice, "input": "hi"})
        checks["rejects_missing_key"] = r.status_code == 401
    r = await client.post("/v1/audio/speech", json={"voice": "nonexistentvoice000", "input": "hello"})
    checks["unknown_voice_404"] = r.status_code == 404
    r = await client.post("/v1/audio/speech", json={"voice": voice, "input": "   "})
    checks["empty_input_400"] = r.status_code == 400
    r = await client.post("/v1/audio/speech", json={"voice": voice, "input": PROMPTS[0], "response_format": "wav"})
    ok = r.status_code == 200 and r.content[:4] == b"RIFF" and len(r.content) > 44
    if ok:
        rate = struct.unpack("<I", r.content[24:28])[0]
        data = struct.unpack("<I", r.content[40:44])[0]
        ok = rate == RATE and data == len(r.content) - 44
    checks["wav_valid_header"] = ok
    r = await client.post("/v1/audio/speech", json={"voice": voice, "input": PROMPTS[1], "response_format": "pcm"})
    checks["pcm_non_stream_valid"] = r.status_code == 200 and len(r.content) > 960 and len(r.content) % 2 == 0
    long = await speak(client, voice, LONG, out / f"{name}-long.pcm")
    # ~90 words: anything over 15 s proves every chunk was spoken (one chunk is <= 15 s)
    checks["long_multi_chunk_stream"] = bool(long["ok"] and long["audio_s"] > 15)
    return checks, long


async def tier(clients, voice, concurrency, batches, out, results, save):
    names = list(clients)
    for batch in range(batches):
        order = names if batch % 2 == 0 else names[::-1]  # interleave to cancel time-of-day drift
        for name in order:
            rows = await asyncio.gather(*(
                speak(clients[name], voice, PROMPTS[(batch + i) % len(PROMPTS)],
                      out / f"{name}-c{concurrency}-b{batch}-p{(batch + i) % len(PROMPTS)}.pcm" if save and i == 0 else None)
                for i in range(concurrency)))
            for row in rows:
                row.update(target=name, concurrency=concurrency, batch=batch)
            results.extend(rows)


async def soak(client, name, voice, concurrency, seconds, results):
    deadline = time.monotonic() + seconds
    async def worker(w):
        i = w
        while time.monotonic() < deadline:
            row = await speak(client, voice, PROMPTS[i % len(PROMPTS)])
            row.update(target=name, phase="soak", at_s=seconds - (deadline - time.monotonic()))
            results.append(row)
            i += concurrency
    await asyncio.gather(*(worker(w) for w in range(concurrency)))


async def idle_gaps(client, name, voice, count, results):
    """Interview-turn pacing: idle gaps around server keep-alive expiry (5 s)."""
    for i in range(count):
        await asyncio.sleep(random.uniform(4.5, 6.5))
        row = await speak(client, voice, PROMPTS[i % len(PROMPTS)])
        row.update(target=name, phase="idle-gap")
        results.append(row)


async def main(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    clients = {}
    for spec in a.target:
        name, rest = spec.split("=", 1)
        url, key_env = rest.rsplit("=", 1)
        clients[name] = httpx.AsyncClient(base_url=url, headers={"Authorization": f"Bearer {os.environ[key_env]}"},
                                          timeout=httpx.Timeout(120, connect=15))
    report = {"started": time.time(), "voice": a.voice, "tiers": a.tiers, "batches": a.batches, "contract": {},
              "rows": [], "summary": {}}
    save = lambda: (out / "results.json").write_text(json.dumps(report, indent=2))  # noqa: E731
    try:
        for name, client in clients.items():
            report["contract"][name], report.setdefault("long", {})[name] = await contract(name, client, a.voice, out)
            save()
            print(name, "contract", report["contract"][name], flush=True)
        for c in a.tiers:  # warm every batch shape before measuring it
            warm = []
            await tier(clients, a.voice, c, 2, out, warm, False)
            report.setdefault("warmups", []).extend(warm)
            rows = []
            await tier(clients, a.voice, c, a.batches, out, rows, c == 1)
            report["rows"].extend(rows)
            for name in clients:
                s = summarize([r for r in rows if r["target"] == name])
                report["summary"][f"{name}@{c}"] = s
                print(name, c, json.dumps({k: s[k] for k in ("success", "ttfa_ms", "total_ms", "stall_ms")}), flush=True)
            save()
        for spec in a.capacity:
            name, c = spec.split(":")
            rows = []
            await tier({name: clients[name]}, a.voice, int(c), 2, out, [], False)
            await tier({name: clients[name]}, a.voice, int(c), a.batches, out, rows, False)
            report["rows"].extend(rows)
            report["summary"][f"{name}@{c}"] = s = summarize(rows)
            print(name, c, json.dumps({k: s[k] for k in ("success", "ttfa_ms", "total_ms", "stall_ms")}), flush=True)
            save()
        if a.idle_gap_requests:
            rows = []
            await asyncio.gather(*(idle_gaps(c, n, a.voice, a.idle_gap_requests, rows) for n, c in clients.items()))
            report["idle_gap"] = {n: summarize([r for r in rows if r["target"] == n]) for n in clients}
            report["idle_gap_rows"] = rows
            print("idle-gap", json.dumps({n: (s["success"], s["requests"], s["errors"]) for n, s in report["idle_gap"].items()}), flush=True)
            save()
        if a.soak_seconds:
            rows = []
            await soak(clients[a.soak_target], a.soak_target, a.voice, a.soak_concurrency, a.soak_seconds, rows)
            report["soak"] = {"concurrency": a.soak_concurrency, "seconds": a.soak_seconds, "summary": summarize(rows),
                              "rows": rows}
            print("soak", json.dumps(report["soak"]["summary"]), flush=True)
    finally:
        report["finished"] = time.time()
        save()
        for client in clients.values():
            await client.aclose()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--target", action="append", default=[], help="name=url=KEY_ENV")
    p.add_argument("--voice")
    p.add_argument("--out", default="tts-benchmark")
    p.add_argument("--tiers", type=lambda s: [int(x) for x in s.split(",")], default=[1, 2, 4])
    p.add_argument("--batches", type=int, default=10)
    p.add_argument("--capacity", action="append", default=[], help="name:concurrency, single-target extra tier")
    p.add_argument("--soak-target")
    p.add_argument("--soak-concurrency", type=int, default=4)
    p.add_argument("--soak-seconds", type=int, default=0)
    p.add_argument("--idle-gap-requests", type=int, default=0)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        assert pct([4, 1, 2, 3], .95) == 4 and pct([4, 1, 2, 3], .5) == 2
        assert summarize([{"ok": False, "error": "x"}])["success"] == 0
        row = {"ok": True, "ttfa_ms": 1, "total_ms": 2, "rtf": .5, "stall_ms": 0, "max_gap_ms": 3}
        assert summarize([row])["ttfa_ms"]["p50"] == 1 and summarize([row])["stalled_requests"] == 0
        print("self-check passed")
    else:
        asyncio.run(main(args))
