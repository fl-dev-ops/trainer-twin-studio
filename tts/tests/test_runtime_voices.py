"""Runtime voice registration: no model-server restart for new or changed voices."""
import asyncio

import httpx
import pytest
import pytest_asyncio
from app import config
from app import main as service
from app.profiles import VoiceProfiles
from app.runtime_voices import PREFIX, RETRY_AFTER_SECONDS, RuntimeVoices, runtime_name

META = {"audioUrl": "https://s3.invalid/ref.wav", "transcript": "reference words", "version": "v1"}


class Backend:
    def __init__(self):
        self.uploads, self.deletes, self.uploaded = [], [], []
        self.upload_status = 200
        self.audio = b"RIFF" + b"\x00" * 100

    async def handler(self, request):
        if request.url.host == "s3.invalid":
            await asyncio.sleep(0.01)
            return httpx.Response(200, content=self.audio)
        if request.method == "GET" and request.url.path == "/v1/audio/voices":
            return httpx.Response(200, json={"voices": [], "uploaded_voices": [{"name": n} for n in self.uploaded]})
        if request.method == "POST" and request.url.path == "/v1/audio/voices":
            body = request.content.decode(errors="ignore")
            self.uploads.append(body)
            return httpx.Response(self.upload_status, json={"success": self.upload_status == 200})
        if request.method == "DELETE":
            self.deletes.append(request.url.path.rsplit("/", 1)[1])
            return httpx.Response(200)
        return httpx.Response(404)


pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def rv():
    fake = Backend()
    transport = httpx.MockTransport(fake.handler)
    async with httpx.AsyncClient(base_url="http://backend", transport=transport) as backend, \
            httpx.AsyncClient(transport=transport) as audio:
        voices = RuntimeVoices(backend, audio)
        yield voices, fake
        await voices.close()


async def settle(voices):
    await asyncio.gather(*list(voices._tasks.values()), return_exceptions=True)


async def test_name_is_versioned_and_safe():
    name = runtime_name("Voice1", META)
    assert name.startswith(PREFIX + "voice1-") and name == name.lower()
    assert name == runtime_name("Voice1", dict(META))
    for change in ({"version": "v2"}, {"transcript": "other words"}, {"transcript": None}):
        assert runtime_name("Voice1", {**META, **change}) != name


async def test_registers_once_in_background_then_selects(rv):
    voices, fake = rv
    assert voices.select("voice1", META) is None
    for _ in range(5):
        voices.ensure("voice1", META)  # concurrent first requests: single upload
    await settle(voices)
    assert len(fake.uploads) == 1
    assert "reference words" in fake.uploads[0] and "trainertwin" in fake.uploads[0]
    assert voices.select("voice1", META) == runtime_name("voice1", META)
    voices.ensure("voice1", META)
    await settle(voices)
    assert len(fake.uploads) == 1  # already registered


async def test_new_version_replaces_and_deletes_old(rv):
    voices, fake = rv
    voices.ensure("voice1", META)
    await settle(voices)
    old = runtime_name("voice1", META)
    newer = {**META, "version": "v2"}
    voices.ensure("voice1", newer)
    await settle(voices)
    assert fake.deletes == [old]
    assert voices.select("voice1", META) is None
    assert voices.select("voice1", newer) == runtime_name("voice1", newer)


async def test_failure_backs_off_and_stays_inline(rv):
    voices, fake = rv
    fake.upload_status = 500
    voices.ensure("voice1", META)
    await settle(voices)
    assert voices.select("voice1", META) is None
    voices.ensure("voice1", META)
    await settle(voices)
    assert len(fake.uploads) == 1  # within the retry window: no upload storm
    fake.upload_status = 200
    # Backdate the failure (patching time.monotonic would freeze the event loop's clock).
    voices._failed_at[runtime_name("voice1", META)] -= RETRY_AFTER_SECONDS + 1
    voices.ensure("voice1", META)
    await settle(voices)
    assert voices.select("voice1", META) is not None


async def test_oversized_or_empty_reference_rejected(rv, monkeypatch):
    voices, fake = rv
    monkeypatch.setattr("app.runtime_voices.MAX_REFERENCE_BYTES", 10)
    voices.ensure("voice1", META)
    await settle(voices)
    assert not fake.uploads and voices.select("voice1", META) is None
    fake.audio = b""
    voices.ensure("voice2", META)
    await settle(voices)
    assert not fake.uploads


async def test_unversioned_voice_stays_inline(rv):
    voices, fake = rv
    voices.ensure("voice1", {**META, "version": None})
    await settle(voices)
    assert not fake.uploads and voices.select("voice1", {**META, "version": None}) is None


async def test_sync_learns_existing_uploads_after_restart(rv):
    voices, fake = rv
    fake.uploaded = [runtime_name("voice1", META), "someone-elses-voice"]
    await voices.sync()
    assert voices.names == {runtime_name("voice1", META)}
    assert voices.select("voice1", META) is not None


async def test_payload_priority_profile_then_runtime_then_inline(rv, monkeypatch):
    voices, fake = rv
    profiles = VoiceProfiles("", config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION)
    monkeypatch.setattr(service, "profiles", profiles)
    monkeypatch.setattr(service, "runtime", voices)
    req = service.SpeechRequest(voice="voice1", input="hi", stream=True)
    inline = service.build_payload(req, META)
    assert inline["voice"] == "default" and inline["ref_audio"] and inline["ref_text"] == "reference words"
    voices.names.add(runtime_name("voice1", META))
    registered = service.build_payload(req, META)
    assert registered["voice"] == runtime_name("voice1", META)
    assert "ref_audio" not in registered and registered["ref_text"] == "reference words"
    profiles.entries["voice1", "v1"] = "profile-voice1"
    best = service.build_payload(req, META)
    assert best["voice"] == "profile-voice1" and "ref_audio" not in best and "ref_text" not in best
