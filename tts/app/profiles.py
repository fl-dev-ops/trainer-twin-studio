"""Versioned, immutable VoxCPM2 voice profiles shared with the model server."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


def profile_name(voice_id: str, version: str, revision: str) -> str:
    key = "\0".join((voice_id, version, revision))
    return "voice-" + hashlib.sha256(key.encode()).hexdigest()


class VoiceProfiles:
    def __init__(self, directory: str, model: str, revision: str):
        self.entries: dict[tuple[str, str], str] = {}
        if not directory:
            return
        root = Path(directory).resolve()
        manifest = root / "custom_voice_manifest.json"
        if not manifest.exists():
            return
        if manifest.stat().st_size > 1024 * 1024:
            raise ValueError("Voice profile manifest exceeds 1 MiB")
        data = json.loads(manifest.read_text())
        if (data.get("schema_version") != 1 or data.get("model_type") != "voxcpm2"
                or data.get("model") != model or data.get("model_revision") != revision):
            raise ValueError("Voice profiles do not match the configured model/revision")
        voices = data.get("voices")
        if not isinstance(voices, dict):
            raise ValueError("Voice profile manifest must contain a voices object")
        for name, entry in voices.items():
            voice_id, version = entry.get("tts_voice_id"), entry.get("tts_voice_version")
            if not isinstance(voice_id, str) or not voice_id or not isinstance(version, str) or not version:
                raise ValueError("Voice profiles require a voice ID and version")
            if name != profile_name(voice_id, version, revision) or entry.get("name") != name:
                raise ValueError("Invalid versioned voice profile name")
            path = (root / entry["file"]).resolve()
            if not path.is_relative_to(root) or path.suffix != ".safetensors" or not path.is_file():
                raise ValueError("Voice profile file is missing or outside the profile directory")
            if entry.get("mode") not in ("reference", "continuation"):
                raise ValueError("Unsupported voice profile conditioning mode")
            self.entries[voice_id, version] = name

    def select(self, voice_id: str, meta: dict) -> str | None:
        return self.entries.get((voice_id, meta.get("version")))
