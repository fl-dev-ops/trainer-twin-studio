"""Environment configuration for the TTS service."""

import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


# The Next.js app server owns voice identity. We ask IT for reference URLs;
# we never touch S3 or tenant naming ourselves.
APP_BASE_URL = os.environ["APP_BASE_URL"].rstrip("/")     # e.g. http://localhost:3000
APP_API_KEY = os.environ["APP_API_KEY"]                    # shared secret, sent as Bearer

VOXCPM_MODEL_ID = os.environ.get("VOXCPM_MODEL_ID", "voxcpm2")  # advertised model name
VOXCPM_MODEL = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")
LOAD_DENOISER = os.environ.get("LOAD_DENOISER", "false").lower() == "true"

CACHE_DIR = Path(os.environ.get("TTS_CACHE_DIR", "/tmp/trainertwin-tts-cache"))

CFG_VALUE = float(os.environ.get("TTS_CFG_VALUE", "2.0"))
INFERENCE_TIMESTEPS = _int("TTS_INFERENCE_TIMESTEPS", 10)
MAX_TEXT_CHARS = _int("TTS_MAX_TEXT_CHARS", 5000)

API_KEY = os.environ.get("TTS_API_KEY")  # bearer check on OUR endpoints; unset = open
