"""Resume Mastery domain contracts."""

from .artifacts import (
    ResumeArtifactReference,
    ResumeArtifactReferenceError,
    parse_resume_artifact_reference,
)
from .controller import ResumeQuestionController, ResumeQuestionValidationError
from .eligibility import (
    ClaimEligibility,
    classify_claim_eligibility,
    is_claim_eligible,
    require_round_angle,
)
from .models import (
    RESUME_DOCUMENT_SCHEMA,
    ResumeClaimKind,
    ResumeClaimV1,
    ResumeDocumentLimits,
    ResumeDocumentV1,
    is_contact_like_text,
    is_contact_section,
    is_control_like_text,
    parse_resume_document,
    parse_resume_document_json,
)
from .progress import (
    MainQuestionProgress,
    ResumeProgressError,
    ResumeProgressPhase,
    ResumeProgressSnapshot,
    ResumeQuestionKind,
    ResumeQuestionRef,
    SelectedRoundProgress,
)
from .repository import (
    JsonObjectReader,
    ResumeDocumentRepository,
    ResumeRepositoryError,
)
from .rpc import ResumeRpcClient

__all__ = [
    "RESUME_DOCUMENT_SCHEMA",
    "ClaimEligibility",
    "JsonObjectReader",
    "MainQuestionProgress",
    "ResumeArtifactReference",
    "ResumeArtifactReferenceError",
    "ResumeClaimKind",
    "ResumeClaimV1",
    "ResumeDocumentLimits",
    "ResumeDocumentRepository",
    "ResumeDocumentV1",
    "ResumeProgressError",
    "ResumeProgressPhase",
    "ResumeProgressSnapshot",
    "ResumeQuestionController",
    "ResumeQuestionKind",
    "ResumeQuestionRef",
    "ResumeQuestionValidationError",
    "ResumeRepositoryError",
    "ResumeRpcClient",
    "SelectedRoundProgress",
    "classify_claim_eligibility",
    "is_claim_eligible",
    "is_contact_like_text",
    "is_contact_section",
    "is_control_like_text",
    "parse_resume_artifact_reference",
    "parse_resume_document",
    "parse_resume_document_json",
    "require_round_angle",
]
