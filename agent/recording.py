"""Session recording: wrap mixed PCM in a WAV container and upload to the studio."""

import struct

import httpx
from loguru import logger


def pcm_to_wav(pcm: bytes, sample_rate: int, num_channels: int) -> bytes:
    """Wrap raw 16-bit LE PCM in a minimal 44-byte WAV header."""
    bits = 16
    byte_rate = sample_rate * num_channels * bits // 8
    block_align = num_channels * bits // 8
    header = (
        b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, num_channels, sample_rate, byte_rate, block_align, bits)
        + b"data" + struct.pack("<I", len(pcm))
    )
    return header + pcm


async def upload_recording(web_url: str, session_id: str, wav: bytes) -> None:
    """Upload the finished recording; raises so callers can log and continue."""
    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.post(
            f"{web_url}/api/sessions/recording",
            params={"sessionId": session_id},
            content=wav,
            headers={"Content-Type": "audio/wav"},
        )
        response.raise_for_status()
    logger.info("Uploaded recording for session {} ({} KB)", session_id, len(wav) // 1024)
