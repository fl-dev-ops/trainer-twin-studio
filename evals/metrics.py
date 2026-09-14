from deepeval.metrics import (
    ConversationCompletenessMetric,
    ConversationalGEval,
    RoleAdherenceMetric,
    TurnContextualRelevancyMetric,
    TurnFaithfulnessMetric,
    TurnRelevancyMetric,
)
from deepeval.models import OpenRouterModel
from deepeval.test_case.conversational_test_case import MultiTurnParams

JUDGE = OpenRouterModel(model="openai/gpt-4.1", temperature=0)

MULTI_TURN_METRICS = [
    RoleAdherenceMetric(threshold=0.7, model=JUDGE, async_mode=False),
    TurnRelevancyMetric(threshold=0.7, model=JUDGE, async_mode=False),
    TurnFaithfulnessMetric(threshold=0.7, model=JUDGE, window_size=10, async_mode=False),
    TurnContextualRelevancyMetric(threshold=0.6, model=JUDGE, window_size=10, async_mode=False),
    ConversationCompletenessMetric(threshold=0.7, model=JUDGE, async_mode=False),
    ConversationalGEval(
        name="Natural Session Flow",
        threshold=0.7,
        model=JUDGE,
        async_mode=False,
        evaluation_params=[
            MultiTurnParams.ROLE,
            MultiTurnParams.CONTENT,
            MultiTurnParams.SCENARIO,
            MultiTurnParams.EXPECTED_OUTCOME,
        ],
        criteria=(
            "Evaluate whether the complete 30-turn conversation feels like a real human trainer session: "
            "a warm opening and orientation; attentive handling of hesitation, incomplete speech, questions, "
            "false/conflicting claims and uncertainty; natural progression rather than repeating a fixed probe; "
            "brief acknowledgements and corrections; coherent open threads; and a graceful ending. Penalize "
            "formulaic acknowledgement-question repetition, ignoring the learner, interrogating invented facts, "
            "or exposing system language."
        ),
    ),
    ConversationalGEval(
        name="Vasanth-like Behaviour and Style",
        threshold=0.65,
        model=JUDGE,
        async_mode=False,
        evaluation_params=[
            MultiTurnParams.ROLE,
            MultiTurnParams.CONTENT,
            MultiTurnParams.RETRIEVAL_CONTEXT,
        ],
        criteria=(
            "Evaluate whether the trainer uses the interaction behaviour and speaking texture demonstrated by "
            "the retrieved Vasanth examples across the conversation: direct but encouraging, acknowledges before "
            "challenging, corrects false claims clearly, asks for mechanisms/examples/trade-offs, handles 'I don't "
            "know' without hostility, varies question shape, and follows the learner's actual words. It must not "
            "copy candidate names, projects or factual claims from retrieved examples."
        ),
    ),
]
