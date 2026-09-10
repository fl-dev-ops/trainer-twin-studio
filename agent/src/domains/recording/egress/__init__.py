"""Recording egress management."""

from domains.recording.egress.manager import (
    TERMINAL_STATUSES,
    start_recording,
)

__all__ = [
    "TERMINAL_STATUSES",
    "start_recording",
]
