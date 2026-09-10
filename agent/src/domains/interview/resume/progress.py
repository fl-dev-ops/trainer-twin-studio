"""Selected-round Resume Mastery progress and transition invariants."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, replace
from enum import Enum

from domains.interview.runtime import ResumeRound

from .eligibility import require_round_angle

MAX_CONFIGURED_FOLLOW_UPS = 3


class ResumeProgressError(ValueError):
    """Raised when a progress operation violates the selected-round contract."""


class ResumeProgressPhase(str, Enum):
    ACTIVE = "active"
    FINISHING = "finishing"
    FINISHED = "finished"


class ResumeQuestionKind(str, Enum):
    MAIN = "main"
    FOLLOW_UP = "follow_up"


@dataclass(frozen=True)
class ResumeQuestionRef:
    id: str
    kind: ResumeQuestionKind
    main_number: int
    angle_id: str
    primary_claim_id: str
    related_claim_ids: tuple[str, ...]


@dataclass(frozen=True)
class MainQuestionProgress:
    question_id: str
    angle_id: str
    primary_claim_id: str
    related_claim_ids: tuple[str, ...]
    follow_up_count: int = 0


@dataclass(frozen=True)
class ResumeProgressSnapshot:
    selected_round: ResumeRound
    phase: ResumeProgressPhase
    highlighted_section_count: int
    main_question_count: int
    follow_up_count: int
    current_section_main_questions_remaining: int
    current_main_follow_ups_remaining: int
    active_question: ResumeQuestionRef | None
    pending_question: ResumeQuestionRef | None
    can_finish: bool


class SelectedRoundProgress:
    """Own counts and ordering for exactly one Resume Mastery round."""

    def __init__(
        self,
        *,
        selected_round: ResumeRound,
        angle_ids: Iterable[str],
        highlighted_sections_per_session: int,
        main_questions_per_section: int,
        max_follow_ups_per_main: int,
    ) -> None:
        configured_angles = tuple(angle_ids)
        if not isinstance(selected_round, ResumeRound):
            raise ResumeProgressError("selected_round must be a ResumeRound")
        if (
            not configured_angles
            or any(
                not isinstance(angle, str)
                or not angle.strip()
                or angle != angle.strip()
                for angle in configured_angles
            )
            or len(configured_angles) != len(set(configured_angles))
        ):
            raise ResumeProgressError("angle_ids must be non-empty and distinct")
        if (
            isinstance(highlighted_sections_per_session, bool)
            or not isinstance(highlighted_sections_per_session, int)
            or highlighted_sections_per_session <= 0
        ):
            raise ResumeProgressError(
                "highlighted_sections_per_session must be a positive integer"
            )
        if (
            isinstance(main_questions_per_section, bool)
            or not isinstance(main_questions_per_section, int)
            or not 1 <= main_questions_per_section <= len(configured_angles)
        ):
            raise ResumeProgressError(
                "main_questions_per_section must be between 1 and the configured "
                "angle count"
            )
        if (
            isinstance(max_follow_ups_per_main, bool)
            or not isinstance(max_follow_ups_per_main, int)
            or not 0 <= max_follow_ups_per_main <= MAX_CONFIGURED_FOLLOW_UPS
        ):
            raise ResumeProgressError(
                "max_follow_ups_per_main must be an integer from 0 through 3"
            )

        self.selected_round = selected_round
        self.angle_ids = configured_angles
        self.requested_highlighted_sections_per_session = (
            highlighted_sections_per_session
        )
        self.highlighted_sections_per_session = highlighted_sections_per_session
        self.main_questions_per_section = main_questions_per_section
        self.max_follow_ups_per_main = max_follow_ups_per_main
        self.phase = ResumeProgressPhase.ACTIVE
        self._eligible_claim_ids: frozenset[str] | None = None
        self._highlighted_claim_ids: list[str] = []
        self._used_angles_by_claim: dict[str, set[str]] = {}
        self._mains: list[MainQuestionProgress] = []
        self._active_question: ResumeQuestionRef | None = None
        self._pending_question: ResumeQuestionRef | None = None
        self._next_question_sequence = 1

    def configure_available_claims(self, claim_ids: Iterable[str]) -> int:
        """Bind eligible claims before the first question and reduce the section target."""

        if self._eligible_claim_ids is not None:
            raise ResumeProgressError("available claims are already configured")
        if self._mains or self._active_question is not None or self._pending_question is not None:
            raise ResumeProgressError("available claims must be configured before questions")
        configured = tuple(claim_ids)
        if (
            not configured
            or any(not isinstance(item, str) or not item.strip() for item in configured)
            or len(configured) != len(set(configured))
        ):
            raise ResumeProgressError("available claim IDs must be non-empty and distinct")
        self._eligible_claim_ids = frozenset(configured)
        self.highlighted_sections_per_session = min(
            self.requested_highlighted_sections_per_session,
            len(configured),
        )
        return self.highlighted_sections_per_session

    @property
    def mains(self) -> tuple[MainQuestionProgress, ...]:
        return tuple(self._mains)

    @property
    def active_question(self) -> ResumeQuestionRef | None:
        return self._active_question

    @property
    def pending_question(self) -> ResumeQuestionRef | None:
        return self._pending_question

    @property
    def current_main(self) -> MainQuestionProgress | None:
        return self._mains[-1] if self._mains else None

    @property
    def main_question_count(self) -> int:
        return len(self._mains)

    @property
    def follow_up_count(self) -> int:
        return sum(main.follow_up_count for main in self._mains)

    @property
    def highlighted_section_count(self) -> int:
        return len(self._highlighted_claim_ids)

    def _main_question_count_for_claim(self, claim_id: str) -> int:
        return sum(1 for main in self._mains if main.primary_claim_id == claim_id)

    @property
    def current_section_main_questions_remaining(self) -> int:
        if not self._highlighted_claim_ids:
            return self.main_questions_per_section
        current_claim_id = self._highlighted_claim_ids[-1]
        return self.main_questions_per_section - self._main_question_count_for_claim(
            current_claim_id
        )

    def unused_angle_ids_for_claim(self, claim_id: str) -> tuple[str, ...]:
        used = self._used_angles_by_claim.get(claim_id, set())
        return tuple(angle_id for angle_id in self.angle_ids if angle_id not in used)

    @property
    def current_main_follow_ups_remaining(self) -> int:
        main = self.current_main
        if main is None:
            return 0
        return self.max_follow_ups_per_main - main.follow_up_count

    @property
    def required_main_question_count(self) -> int:
        return (
            self.highlighted_sections_per_session * self.main_questions_per_section
        )

    @property
    def can_finish(self) -> bool:
        return (
            self.phase is ResumeProgressPhase.ACTIVE
            and self.main_question_count == self.required_main_question_count
            and self._active_question is None
            and self._pending_question is None
        )

    def _require_active_phase(self) -> None:
        if self.phase is not ResumeProgressPhase.ACTIVE:
            raise ResumeProgressError("progress is locked for finishing")

    def _require_no_outstanding_question(self) -> None:
        if self._active_question is not None or self._pending_question is not None:
            raise ResumeProgressError("resolve the active or pending question first")

    def _next_id(self, kind: ResumeQuestionKind) -> str:
        question_id = f"{kind.value}:{self._next_question_sequence}"
        self._next_question_sequence += 1
        return question_id

    def queue_main_question(
        self,
        *,
        angle_id: str,
        primary_claim_id: str,
        related_claim_ids: Iterable[str] = (),
    ) -> ResumeQuestionRef:
        """Reserve a main; counts change only after successful presentation."""

        self._require_active_phase()
        self._require_no_outstanding_question()
        try:
            require_round_angle(angle_id, self.angle_ids)
        except ValueError as error:
            raise ResumeProgressError(str(error)) from error
        if self._eligible_claim_ids is None:
            raise ResumeProgressError("available claims are not configured")
        if self.main_question_count >= self.required_main_question_count:
            raise ResumeProgressError("main question limit reached")
        if (
            not isinstance(primary_claim_id, str)
            or not primary_claim_id.strip()
            or primary_claim_id != primary_claim_id.strip()
        ):
            raise ResumeProgressError("primary_claim_id must be non-empty")
        if primary_claim_id not in self._eligible_claim_ids:
            raise ResumeProgressError("primary_claim_id is not an available claim")
        if angle_id in self._used_angles_by_claim.get(primary_claim_id, set()):
            raise ResumeProgressError("angle_id was already used for this claim")

        if self._highlighted_claim_ids:
            current_claim_id = self._highlighted_claim_ids[-1]
            current_count = self._main_question_count_for_claim(current_claim_id)
            if current_count < self.main_questions_per_section:
                if primary_claim_id != current_claim_id:
                    raise ResumeProgressError(
                        "complete the configured main questions for the current section"
                    )
            elif primary_claim_id in self._highlighted_claim_ids:
                raise ResumeProgressError(
                    "the next section must use a new primary claim"
                )
            elif (
                self.highlighted_section_count
                >= self.highlighted_sections_per_session
            ):
                raise ResumeProgressError("highlighted section limit reached")
        related = tuple(related_claim_ids)
        if any(
            not isinstance(item, str)
            or not item.strip()
            or item != item.strip()
            for item in related
        ):
            raise ResumeProgressError("related_claim_ids must be non-empty strings")
        if len(related) != len(set(related)) or primary_claim_id in related:
            raise ResumeProgressError("primary and related claim IDs must be distinct")

        pending = ResumeQuestionRef(
            id=self._next_id(ResumeQuestionKind.MAIN),
            kind=ResumeQuestionKind.MAIN,
            main_number=self.main_question_count + 1,
            angle_id=angle_id,
            primary_claim_id=primary_claim_id,
            related_claim_ids=related,
        )
        self._pending_question = pending
        return pending

    def queue_follow_up(self) -> ResumeQuestionRef:
        """Reserve a response-grounded follow-up for the current main."""

        self._require_active_phase()
        self._require_no_outstanding_question()
        main = self.current_main
        if main is None:
            raise ResumeProgressError("a follow-up requires a presented main question")
        if main.follow_up_count >= self.max_follow_ups_per_main:
            raise ResumeProgressError("follow-up limit reached for the current main")
        pending = ResumeQuestionRef(
            id=self._next_id(ResumeQuestionKind.FOLLOW_UP),
            kind=ResumeQuestionKind.FOLLOW_UP,
            main_number=self.main_question_count,
            angle_id=main.angle_id,
            primary_claim_id=main.primary_claim_id,
            related_claim_ids=main.related_claim_ids,
        )
        self._pending_question = pending
        return pending

    def mark_pending_presented(self) -> ResumeQuestionRef:
        """Commit one pending question after its speech succeeds."""

        self._require_active_phase()
        pending = self._pending_question
        if pending is None:
            raise ResumeProgressError("there is no pending question")
        if pending.kind is ResumeQuestionKind.MAIN:
            if pending.primary_claim_id not in self._highlighted_claim_ids:
                self._highlighted_claim_ids.append(pending.primary_claim_id)
            self._used_angles_by_claim.setdefault(
                pending.primary_claim_id,
                set(),
            ).add(pending.angle_id)
            self._mains.append(
                MainQuestionProgress(
                    question_id=pending.id,
                    angle_id=pending.angle_id,
                    primary_claim_id=pending.primary_claim_id,
                    related_claim_ids=pending.related_claim_ids,
                )
            )
        else:
            main = self.current_main
            if main is None or pending.main_number != self.main_question_count:
                raise ResumeProgressError("pending follow-up lost its main question")
            self._mains[-1] = replace(
                main,
                follow_up_count=main.follow_up_count + 1,
            )
        self._pending_question = None
        self._active_question = pending
        return pending

    def cancel_pending(self) -> ResumeQuestionRef:
        """Discard an unsaid question without consuming its angle or count."""

        self._require_active_phase()
        pending = self._pending_question
        if pending is None:
            raise ResumeProgressError("there is no pending question")
        self._pending_question = None
        return pending

    def record_response(self) -> ResumeQuestionRef:
        """Mark the active question answered before queuing the next operation."""

        self._require_active_phase()
        active = self._active_question
        if active is None:
            raise ResumeProgressError("there is no active question")
        self._active_question = None
        return active

    def begin_finishing(self) -> bool:
        """Lock progress after all required mains have received responses."""

        if self.phase in {ResumeProgressPhase.FINISHING, ResumeProgressPhase.FINISHED}:
            return False
        if not self.can_finish:
            raise ResumeProgressError("required mains or question resolution are incomplete")
        self.phase = ResumeProgressPhase.FINISHING
        return True

    def mark_finished(self) -> bool:
        if self.phase is ResumeProgressPhase.FINISHED:
            return False
        if self.phase is not ResumeProgressPhase.FINISHING:
            raise ResumeProgressError("begin_finishing must run before mark_finished")
        self.phase = ResumeProgressPhase.FINISHED
        return True

    def snapshot(self) -> ResumeProgressSnapshot:
        return ResumeProgressSnapshot(
            selected_round=self.selected_round,
            phase=self.phase,
            highlighted_section_count=self.highlighted_section_count,
            main_question_count=self.main_question_count,
            follow_up_count=self.follow_up_count,
            current_section_main_questions_remaining=(
                self.current_section_main_questions_remaining
            ),
            current_main_follow_ups_remaining=self.current_main_follow_ups_remaining,
            active_question=self._active_question,
            pending_question=self._pending_question,
            can_finish=self.can_finish,
        )
