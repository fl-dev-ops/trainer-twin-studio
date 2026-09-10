"""Resume inspection state management."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from domains.screen.models import (
    ResumeDetails,
    ResumeEndState,
    ResumeViewportObservation,
)


def _normalize_resume_fact(value: str) -> str:
    """Normalize a resume fact for deduplication."""
    return " ".join(value.casefold().split())


def resume_viewport_signature(observation: ResumeViewportObservation) -> str:
    """Generate a signature for deduplication."""
    payload = {
        "visible_sections": sorted(
            _normalize_resume_fact(value) for value in observation.visible_sections
        ),
        "professional_facts": {
            category: sorted(_normalize_resume_fact(value) for value in values)
            for category, values in observation.professional_facts.model_dump().items()
        },
        "page_current": observation.page_current,
        "page_total": observation.page_total,
        "content_clipped_at_bottom": observation.content_clipped_at_bottom,
        "scrollbar_position": observation.scrollbar_position.value,
        "end_state": observation.end_state.value,
    }
    return json.dumps(payload, ensure_ascii=True, sort_keys=True)


def resume_viewport_metadata(
    observation: ResumeViewportObservation,
) -> dict[str, object]:
    """Extract metadata from a viewport observation."""
    return {
        "visible_sections": observation.visible_sections,
        "content_clipped_at_bottom": observation.content_clipped_at_bottom,
        "page_current": observation.page_current,
        "page_total": observation.page_total,
        "scrollbar_position": observation.scrollbar_position.value,
        "end_state": observation.end_state.value,
        "end_reason": observation.end_reason,
        "scroll_instruction": observation.scroll_instruction,
    }


@dataclass
class ResumeInspectionState:
    """State for resume inspection across viewports."""

    details: dict[str, list[str]] = field(
        default_factory=lambda: {key: [] for key in ResumeDetails.model_fields}
    )
    last_viewport_signature: str | None = None
    last_end_state: ResumeEndState | None = None
    last_content_clipped_at_bottom: bool = False
    last_page_current: int | None = None
    last_page_total: int | None = None
    viewport_count: int = 0
    completed_details: ResumeDetails | None = None
    finalized_with_partial_details: bool = False
    finalization_reason: str | None = None

    def accumulated_details(self) -> ResumeDetails:
        """Get accumulated resume details."""
        return ResumeDetails.model_validate(self.details)

    def merge(self, observation: ResumeViewportObservation) -> None:
        """Merge a viewport observation into the accumulated state."""
        for category, values in observation.professional_facts.model_dump().items():
            existing = self.details[category]
            seen = {_normalize_resume_fact(value) for value in existing}
            for value in values:
                cleaned = " ".join(value.split())
                normalized = _normalize_resume_fact(cleaned)
                if cleaned and normalized not in seen:
                    existing.append(cleaned)
                    seen.add(normalized)

        self.last_end_state = observation.end_state
        self.last_content_clipped_at_bottom = observation.content_clipped_at_bottom
        self.last_page_current = observation.page_current
        self.last_page_total = observation.page_total

    def can_finalize(self) -> bool:
        """Check if the resume inspection can be finalized."""
        no_page_counter = (
            self.last_page_current is None and self.last_page_total is None
        )
        page_counter_is_final = (
            self.last_page_current is not None
            and self.last_page_total is not None
            and self.last_page_current == self.last_page_total
        )
        return bool(
            self.last_end_state is ResumeEndState.APPARENT_END
            and not self.last_content_clipped_at_bottom
            and (no_page_counter or page_counter_is_final)
        )
