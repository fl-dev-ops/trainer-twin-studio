"""Public API, streaming failures, profile invalidation, warmup and recovery."""
import asyncio
import json
import struct

import httpx
import pytest
import pytest_asyncio
from app import config
from app import main as service
from app.profiles import VoiceProfiles
from app.voices import AppUnreachable, VoiceStore


class Audio(httpx.AsyncByteStream):
    def __init__(self, parts=(b"\x01\x00" * 480,), failure=None):
        self.parts, self.failure, self.closed = parts, failure, False

    async def __aiter__(self):
        for part in self.parts:
            yield part
        if self.failure:
            raise self.failure

    async def aclose(self):
        self.closed = True


@pytest_asyncio.fixture
async def api(monkeypatch):
    calls, streams = [], []
    state = {"backend_status": 200, "parts": (b"\x01\x00" * 480,), "failure": None,
             "voice_status": 200, "version": "v1", "epoch": "100", "available": []}

    def app_handler(request):
        if state["voice_status"] == 200:
            return httpx.Response(200, json={"audioUrl": "https://s3.invalid/reference.wav", "transcript": "reference words",
                                             "version": state["version"]})
        return httpx.Response(state["voice_status"], json={"error": "private error"})

    def backend_handler(request):
        if request.url.path == "/health":
            return httpx.Response(state["backend_status"])
        if request.url.path == "/metrics":
            return httpx.Response(200, text="process_start_time_seconds " + state["epoch"] + "\n")
        if request.url.path == "/v1/audio/voices":
            return httpx.Response(200, json={"voices": state["available"]})
        calls.append(json.loads(request.content))
        stream = Audio(state["parts"], state["failure"])
        streams.append(stream)
        return httpx.Response(state["backend_status"], stream=stream, headers={"Content-Type": "audio/pcm"})

    app_http = httpx.AsyncClient(base_url="http://app", transport=httpx.MockTransport(app_handler))
    backend = httpx.AsyncClient(base_url="http://backend", transport=httpx.MockTransport(backend_handler))
    store = VoiceStore(app_http, cache_ttl=0)
    monkeypatch.setattr(service, "store", store)
    monkeypatch.setattr(service, "backend", backend)
    monkeypatch.setattr(service, "ready", True)
    monkeypatch.setattr(service, "backend_epoch", None)
    monkeypatch.setattr(service, "profiles", VoiceProfiles("", config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION))
    monkeypatch.setattr(config, "API_KEY", "test-secret")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://test",
                                 headers={"Authorization": "Bearer test-secret"}) as client:
        yield client, state, calls, streams
    await store.close()
    await app_http.aclose()
    await backend.aclose()


def body(**kwargs):
    return {"voice": "voice1", "input": "A short test sentence.", **kwargs}


@pytest.mark.asyncio
async def test_auth_validation_and_readiness(api, monkeypatch):
    client, state, calls, streams = api
    for auth in ("", "Bearer wrong", "test-secret", "Bearer \u2603"):
        # HTTP libraries prohibit non-ASCII header strings; exercise the validator directly for that case.
        if "\u2603" in auth:
            with pytest.raises(service.HTTPException):
                service._check_auth(auth)
        else:
            assert (await client.post("/v1/audio/speech", json=body(), headers={"Authorization": auth})).status_code == 401
    for request, status in ((body(input=" "), 400), (body(input="x" * 5001), 400),
                            (body(response_format="mp3"), 400), (body(model="other"), 400),
                            (body(voice="../secret"), 422), (body(voice=""), 422)):
        assert (await client.post("/v1/audio/speech", json=request)).status_code == status
    assert not calls
    monkeypatch.setattr(service, "ready", False)
    assert (await client.post("/v1/audio/speech", json=body())).status_code == 503
    assert (await client.get("/healthz")).status_code == 503
    assert (await client.get("/livez")).status_code == 200
    assert (await client.get("/v1/models")).json()["data"][0]["id"] == "voxcpm2"


@pytest.mark.asyncio
async def test_pcm_wav_stream_and_chunk_order(api, monkeypatch):
    client, state, calls, streams = api
    monkeypatch.setattr(service, "chunk_text", lambda *a, **k: ["first", "second", "third"])
    r = await client.post("/v1/audio/speech", json=body(stream=True))
    assert r.status_code == 200 and r.content == state["parts"][0] * 3
    assert r.headers["x-sample-rate"] == "48000"
    assert r.headers["x-accel-buffering"] == "no"
    assert r.headers["cache-control"] == "no-store"
    assert [p["input"] for p in calls] == ["first", "second", "third"]
    assert all(s.closed for s in streams)
    calls.clear()
    r = await client.post("/v1/audio/speech", json=body())
    assert r.status_code == 200 and r.content[:4] == b"RIFF"
    assert struct.unpack("<I", r.content[40:44])[0] == len(r.content) - 44
    assert r.content[44:] == state["parts"][0] * 3
    assert all(not p["stream"] for p in calls)
    r = await client.post("/v1/audio/speech", json=body(response_format="pcm"))
    assert r.content == state["parts"][0] * 3


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 404, 429, 500, 503])
async def test_initial_backend_error_never_returns_empty_200(api, status):
    client, state, calls, streams = api
    state["backend_status"] = status
    r = await client.post("/v1/audio/speech", json=body(stream=True))
    assert r.status_code == 502 and "private" not in r.text
    assert all(s.closed for s in streams)


@pytest.mark.asyncio
async def test_empty_malformed_and_timeout_responses(api):
    client, state, calls, streams = api
    state["parts"] = ()
    assert (await client.post("/v1/audio/speech", json=body(stream=True))).status_code == 502
    state["failure"] = httpx.ReadTimeout("private signed URL")
    r = await client.post("/v1/audio/speech", json=body(stream=True))
    assert r.status_code == 504 and "private" not in r.text
    state.update(parts=(b"x",), failure=None)
    assert (await client.post("/v1/audio/speech", json=body())).status_code == 502
    with pytest.raises(RuntimeError, match="TTS stream interrupted"):
        await client.post("/v1/audio/speech", json=body(stream=True))


@pytest.mark.asyncio
async def test_partial_stream_failure_is_not_swallowed(api):
    client, state, calls, streams = api
    state["failure"] = httpx.RemoteProtocolError("backend stopped mid-stream")
    with pytest.raises(RuntimeError, match="TTS stream interrupted"):
        await client.post("/v1/audio/speech", json=body(stream=True))
    assert streams[-1].closed


@pytest.mark.asyncio
async def test_disconnected_consumer_closes_upstream(api):
    client, state, calls, streams = api
    response = await service.speech(service.SpeechRequest(**body(stream=True)), "Bearer test-secret")
    assert await anext(response.body_iterator)
    await response.body_iterator.aclose()
    assert streams[-1].closed


@pytest.mark.asyncio
async def test_voice_404_and_auth_revocation_fail_closed(api):
    client, state, calls, streams = api
    state["voice_status"] = 404
    assert (await client.post("/v1/audio/speech", json=body())).status_code == 404
    state["voice_status"] = 403
    assert (await client.post("/v1/audio/speech", json=body())).status_code == 502
    assert not calls


@pytest.mark.asyncio
async def test_profiles_selected_only_for_matching_live_version(api, monkeypatch):
    client, state, calls, streams = api
    profiles = service.profiles
    profiles.entries["voice1", "v1"] = "cached-name"
    r = await client.post("/v1/audio/speech", json=body(stream=True))
    assert r.status_code == 200 and calls[-1]["voice"] == "cached-name"
    assert "ref_audio" not in calls[-1] and "ref_text" not in calls[-1]
    state["version"] = "v2"
    r = await client.post("/v1/audio/speech", json=body(stream=True))
    assert r.status_code == 200 and calls[-1]["voice"] == "default"
    assert "ref_audio" in calls[-1] and calls[-1]["ref_text"] == "reference words"


@pytest.mark.asyncio
async def test_warmup_gates_ready_and_repeats_after_backend_restart(api, monkeypatch):
    client, state, calls, streams = api
    service.profiles.entries["voice1", "v1"] = "cached-name"
    state["available"] = ["cached-name"]
    monkeypatch.setattr(config, "TTS_WARMUP_CONCURRENCY", (1, 2))
    monkeypatch.setattr(service, "ready", False)
    await service._warm_backend()
    assert service.ready and len(calls) == 3
    await service._warm_backend()
    assert len(calls) == 3
    state["epoch"] = "200"
    await service._warm_backend()
    assert service.ready and len(calls) == 6
    state["available"] = []
    state["epoch"] = "300"
    with pytest.raises(RuntimeError, match="profiles are not loaded"):
        await service._warm_backend()
    assert not service.ready


@pytest.mark.asyncio
async def test_voice_store_singleflight_and_refresh():
    calls = 0
    state = {"version": "v1", "status": 200}
    async def handler(request):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return httpx.Response(state["status"], json={"audioUrl": "https://s3.invalid/ref.wav", "version": state["version"]})
    async with httpx.AsyncClient(base_url="http://app", transport=httpx.MockTransport(handler)) as c:
        store = VoiceStore(c, cache_ttl=10)
        result = await asyncio.gather(*(store.resolve("voice1") for _ in range(10)))
        assert calls == 1 and all(r["version"] == "v1" for r in result)
        state["version"] = "v2"
        store.invalidate("voice1")
        assert (await store.resolve("voice1"))["version"] == "v2" and calls == 2
        store.invalidate("voice1")
        state["status"] = 401
        with pytest.raises(AppUnreachable):
            await store.resolve("voice1")
        assert "voice1" not in store._cache
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("meta", [[], {}, {"audioUrl": "file:///etc/passwd"},
                                     {"audioUrl": "https://s3.invalid/x", "version": {}},
                                     {"audioUrl": "https://s3.invalid/x", "transcript": []}])
async def test_voice_store_rejects_invalid_metadata(meta):
    async with httpx.AsyncClient(base_url="http://app", transport=httpx.MockTransport(lambda r: httpx.Response(200, json=meta))) as c:
        store = VoiceStore(c)
        with pytest.raises(AppUnreachable):
            await store.resolve("voice1")
        await store.close()


def test_backend_keepalive_expires_before_vllm_server():
    # vLLM closes idle keep-alives at 5 s; reusing one past that races into RemoteProtocolError.
    assert service.BACKEND_LIMITS.keepalive_expiry < 5


@pytest.mark.asyncio
async def test_transient_probe_failure_keeps_warm_server_ready(api, monkeypatch):
    client, state, calls, streams = api
    service.profiles.entries["voice1", "v1"] = "cached-name"
    state["available"] = ["cached-name"]
    monkeypatch.setattr(config, "TTS_WARMUP_CONCURRENCY", (1,))
    monkeypatch.setattr(service, "ready", False)
    await service._check_backend()
    assert service.ready and len(calls) == 1
    real_get, failures = service.backend.get, {"left": 1}

    async def flaky_get(path, **kwargs):
        if path == "/health" and failures["left"]:
            failures["left"] -= 1
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return await real_get(path, **kwargs)

    monkeypatch.setattr(service.backend, "get", flaky_get)
    await service._check_backend()
    assert service.ready and len(calls) == 1  # no readiness drop, no re-warm
    failures["left"] = 2  # a confirmed (repeated) failure must fail closed
    await service._check_backend()
    assert not service.ready
