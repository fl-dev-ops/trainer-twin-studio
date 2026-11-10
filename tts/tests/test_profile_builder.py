import json
import runpy
from pathlib import Path
from types import SimpleNamespace

import pytest

BUILDER = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/build_voice_profiles.py"))


def test_atomic_manifest_publish_and_failure_preserves_old(tmp_path, monkeypatch):
    path = tmp_path / "custom_voice_manifest.json"
    BUILDER["atomic_write"](path, json.dumps({"version": "old"}))
    assert json.loads(path.read_text())["version"] == "old"
    original_replace = BUILDER["atomic_write"].__globals__["os"].replace
    def fail(*args):
        raise OSError("disk failure")
    monkeypatch.setattr(BUILDER["atomic_write"].__globals__["os"], "replace", fail)
    with pytest.raises(OSError):
        BUILDER["atomic_write"](path, json.dumps({"version": "new"}))
    assert json.loads(path.read_text())["version"] == "old"
    assert list(tmp_path.iterdir()) == [path]
    monkeypatch.setattr(BUILDER["atomic_write"].__globals__["os"], "replace", original_replace)


def test_builder_validates_before_loading_gpu_dependencies(monkeypatch, tmp_path):
    args = SimpleNamespace(app_base_url="https://app.invalid", revision="main", voice=["voice1"], output_dir=str(tmp_path))
    monkeypatch.setenv("APP_API_KEY", "test")
    with pytest.raises(ValueError, match="immutable"):
        BUILDER["build"](args)
    args.revision = "a" * 40
    args.voice = ["../escape"]
    with pytest.raises(ValueError, match="voice ID"):
        BUILDER["build"](args)
    monkeypatch.delenv("APP_API_KEY")
    with pytest.raises(ValueError, match="APP_BASE_URL"):
        BUILDER["build"](args)
