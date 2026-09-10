from deepeval.metrics import (
    ConversationCompletenessMetric,
    ConversationalGEval,
    RoleAdherenceMetric,
)
from deepeval.test_case import MultiTurnParams


def conversation_metrics(model, threshold: float = 0.7):
    return [
        ConversationalGEval(
            name="Trainer Fidelity",
            model=model,
            threshold=threshold,
            evaluation_params=[
                MultiTurnParams.CONTENT,
                MultiTurnParams.ROLE,
                MultiTurnParams.RETRIEVAL_CONTEXT,
            ],
            evaluation_steps=[
                "Use the context as source-grounded evidence of the real trainer's behavior.",
                "Evaluate only assistant turns for tone, phrasing, question style, acknowledgments, and transitions.",
                "Check whether reactions to strong, vague, partial, contradictory, and unknown answers match the trainer evidence.",
                "Penalize behavior that contradicts the evidence; do not require verbatim copying or matching source topics.",
            ],
        ),
        ConversationCompletenessMetric(model=model, threshold=threshold),
        RoleAdherenceMetric(model=model, threshold=threshold),
    ]
