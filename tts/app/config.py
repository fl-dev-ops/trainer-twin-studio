"""Environment configuration for the TTS service."""

import os

import os as _os


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


# The Next.js app server owns voice identity. We ask IT for reference URLs;
# we never touch S3 or tenant naming ourselves.
APP_BASE_URL = os.environ["APP_BASE_URL"].rstrip("/")     # e.g. http://localhost:3000
APP_API_KEY = os.environ["APP_API_KEY"]                    # shared secret, sent as Bearer

# vLLM-Omni backend serving VoxCPM2 (`vllm serve openbmb/VoxCPM2 --omni`).
TTS_BACKEND_URL = _os.environ.get("TTS_BACKEND_URL", "http://localhost:8001").rstrip("/")

VOXCPM_MODEL_ID = os.environ.get("VOXCPM_MODEL_ID", "voxcpm2")   # advertised to clients
VOXCPM_MODEL = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")  # name the backend knows

# VoxCPM2 emits 48 kHz mono s16le PCM when streaming
SAMPLE_RATE = _int("TTS_SAMPLE_RATE", 48000)

MAX_TEXT_CHARS = _int("TTS_MAX_TEXT_CHARS", 5000)

API_KEY = os.environ.get("TTS_API_KEY")  # bearer check on OUR endpoints; unset = open
