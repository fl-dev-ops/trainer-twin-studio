"""Build immutable VoxCPM2 profiles before starting the GPU backend.

Run with the pinned model environment, not the thin proxy environment.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.profiles import profile_name


def atomic_write(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
        temporary = Path(f.name)
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build(args) -> None:
    key = os.environ.get("APP_API_KEY", "")
    if not key or not args.app_base_url:
        raise ValueError("APP_BASE_URL and APP_API_KEY are required")
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise ValueError("--revision must be an immutable model commit SHA")
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", voice_id) for voice_id in args.voice):
        raise ValueError("Invalid voice ID")
    import torch
    from huggingface_hub import snapshot_download
    from safetensors.torch import save_file
    from vllm_omni.model_executor.models.voxcpm2.voxcpm2_import_utils import (
        import_voxcpm2_core,
    )

    os.umask(0o077)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest_path = output / "custom_voice_manifest.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
            "schema_version": 1, "model_type": "voxcpm2", "model": args.model,
            "model_revision": args.revision, "voices": {},
        }
        if manifest.get("model") != args.model or manifest.get("model_revision") != args.revision:
            raise ValueError("Use a new profile directory for a different model revision")
        snapshot = snapshot_download(args.model, revision=args.revision)
        native = import_voxcpm2_core().from_pretrained(snapshot, load_denoiser=False, optimize=False)
        tts = native.tts_model.to(torch.device(args.device)).eval()
        built, failures = 0, []
        with httpx.Client(base_url=args.app_base_url, timeout=30,
                          headers={"Authorization": f"Bearer {key}"}) as app_http:
            with httpx.Client(timeout=60) as audio_http:
                def build_one(voice_id):
                    response = app_http.get(f"/api/tts/voices/{voice_id}")
                    response.raise_for_status()
                    meta = response.json()
                    version = meta.get("version")
                    if not isinstance(version, str) or not version:
                        raise ValueError("Voice metadata has no version")
                    transcript = meta.get("transcript") or None
                    if transcript is not None and not isinstance(transcript, str):
                        raise ValueError("Invalid voice transcript")
                    name = profile_name(voice_id, version, args.revision)
                    mode = "continuation" if transcript else "reference"
                    with tempfile.NamedTemporaryFile(suffix=".wav", dir=output) as reference:
                        digest = hashlib.sha256()
                        size = 0
                        # Never send the app's credential to a reference-audio host.
                        with audio_http.stream("GET", meta["audioUrl"]) as audio:
                            audio.raise_for_status()
                            for piece in audio.iter_bytes():
                                size += len(piece)
                                if size > 25 * 1024 * 1024:
                                    raise ValueError("Reference audio exceeds 25 MiB")
                                reference.write(piece)
                                digest.update(piece)
                        if not size:
                            raise ValueError("Empty reference audio")
                        reference.flush()
                        check = app_http.get(f"/api/tts/voices/{voice_id}")
                        check.raise_for_status()
                        if check.json().get("version") != version:
                            raise ValueError("Voice changed while building its profile; retry")
                        field = "audio_feat" if transcript else "ref_audio_feat"
                        with torch.inference_mode():
                            features = tts._encode_wav(reference.name, padding_mode="left" if transcript else "right")
                            tensors = {field: features.float().cpu().contiguous()}
                    with tempfile.NamedTemporaryFile(dir=output, delete=False) as f:
                        temporary = Path(f.name)
                    try:
                        save_file(tensors, str(temporary))
                        os.replace(temporary, output / f"{name}.safetensors")
                    finally:
                        temporary.unlink(missing_ok=True)
                    entry = {
                        "name": name, "file": f"{name}.safetensors", "mode": mode,
                        "tts_voice_id": voice_id, "tts_voice_version": version,
                        f"{field}_len": int(tensors[field].shape[0]), "reference_sha256": digest.hexdigest(),
                    }
                    if transcript:
                        entry["prompt_text"] = transcript
                    return name, entry

                for voice_id in dict.fromkeys(args.voice):
                    try:
                        name, entry = build_one(voice_id)
                    except Exception as exc:  # noqa: BLE001 - one bad voice must not block the rest
                        failures.append((voice_id, type(exc).__name__))
                        continue
                    manifest["voices"] = {k: v for k, v in manifest["voices"].items()
                                          if v.get("tts_voice_id") != voice_id}
                    manifest["voices"][name] = entry
                    built += 1
        atomic_write(manifest_path, json.dumps(manifest, indent=2, ensure_ascii=False))
        print(f"Built {built} versioned profile(s); restart backend and proxy to load")
        if failures:
            # Error text can embed signed URLs: report voice IDs and error types only.
            print("Failed voices: " + ", ".join(f"{v} ({e})" for v, e in failures), file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", action="append", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model", default="openbmb/VoxCPM2")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--app-base-url", default=os.environ.get("APP_BASE_URL"))
    parser.add_argument("--device", default="cuda")
    arguments = parser.parse_args()
    try:
        build(arguments)
    except Exception as exc:
        # HTTP exception messages may contain signed URLs: keep failure output secret-free.
        print(f"Profile build failed: {type(exc).__name__}", file=sys.stderr)
        sys.exit(1)
