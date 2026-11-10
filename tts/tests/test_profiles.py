import json

import pytest
from app import config
from app.profiles import VoiceProfiles, profile_name


def manifest(tmp_path, version="v1"):
    name = profile_name("voice1", version, config.VOXCPM_MODEL_REVISION)
    (tmp_path / f"{name}.safetensors").write_bytes(b"fixture")
    data = {"schema_version": 1, "model_type": "voxcpm2", "model": config.VOXCPM_MODEL,
            "model_revision": config.VOXCPM_MODEL_REVISION, "voices": {name: {
                "name": name, "file": f"{name}.safetensors", "mode": "continuation",
                "tts_voice_id": "voice1", "tts_voice_version": version,
            }}}
    return data, name


def load(tmp_path, data):
    (tmp_path / "custom_voice_manifest.json").write_text(json.dumps(data))
    return VoiceProfiles(str(tmp_path), config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION)


def test_versioned_profile_selection(tmp_path):
    data, name = manifest(tmp_path)
    p = load(tmp_path, data)
    assert p.select("voice1", {"version": "v1"}) == name
    assert p.select("voice1", {"version": "v2"}) is None
    assert p.select("voice2", {"version": "v1"}) is None
    assert p.select("voice1", {}) is None
    assert profile_name("voice1", "v1", "different-revision") != name
    assert VoiceProfiles("", config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION).entries == {}
    assert VoiceProfiles(str(tmp_path / "absent"), config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION).entries == {}


@pytest.mark.parametrize("change", ["revision", "model", "name", "file", "mode", "version", "entry", "root"])
def test_reject_invalid_profile_manifest(tmp_path, change):
    data, name = manifest(tmp_path)
    if change == "revision":
        data["model_revision"] = "wrong"
    elif change == "model":
        data["model"] = "wrong"
    elif change == "root":
        data = []
    elif change == "entry":
        data["voices"][name] = []
    else:
        data["voices"][name][{"version": "tts_voice_version"}.get(change, change)] = {
            "name": "forged", "file": "../escape.safetensors", "mode": "ref_continuation", "version": None,
        }[change]
    with pytest.raises(ValueError):
        load(tmp_path, data)


def test_reject_missing_and_symlink_profiles(tmp_path):
    data, name = manifest(tmp_path)
    p = tmp_path / f"{name}.safetensors"
    p.unlink()
    with pytest.raises(ValueError):
        load(tmp_path, data)
    outside = tmp_path.parent / "outside.safetensors"
    outside.write_bytes(b"outside")
    p.symlink_to(outside)
    with pytest.raises(ValueError):
        load(tmp_path, data)


def test_reject_oversized_manifest(tmp_path):
    (tmp_path / "custom_voice_manifest.json").write_text(" " * (1024 * 1024 + 1))
    with pytest.raises(ValueError):
        VoiceProfiles(str(tmp_path), config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION)
