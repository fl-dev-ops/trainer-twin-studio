export function appendSpokenText(current: string, delta: string) {
  return current + delta;
}

export function resetSpokenTextForTool(current: string, hasToolCall: boolean) {
  return hasToolCall ? "" : current;
}

export type PlanSpeechResult = {
  blockedReason?: string;
  nextAction?: {
    kind?: string;
    questionId?: string;
    questionType?: string;
  };
};

export type CompletedSurfaceAction = {
  action: string;
  questionId?: string;
};

export const KNOWLEDGE_GROUNDING_PROMPT =
  "Could you explain the mechanism behind your answer with one concrete example?";

const requiredSurfaceByQuestionType: Record<string, string> = {
  mcq: "open_choice",
  coding: "open_code_editor",
  "code-output": "open_code_editor",
  "machine-coding": "open_code_editor",
  "system-design": "open_whiteboard",
};

export function enforcePlanSpeech(
  text: string,
  options: {
    planRequired: boolean;
    planResult: PlanSpeechResult | null;
    planAdvanced: boolean;
    completedSurfaces: CompletedSurfaceAction[];
    knowledgeRequired?: boolean;
    knowledgeGrounded?: boolean;
  },
) {
  if (!options.planRequired) return text;
  if (!options.planResult || !options.planAdvanced) return "";

  if (
    options.planResult.blockedReason === "knowledge_grounding_required"
    || (options.knowledgeRequired && !options.knowledgeGrounded)
  ) return KNOWLEDGE_GROUNDING_PROMPT;

  if (options.planResult.blockedReason === "code_submission_required") {
    return "Please submit your current code in the editor so I can review it.";
  }
  if (options.planResult.blockedReason === "mcq_selection_required") {
    return "Please select and submit an option before we continue.";
  }

  const action = options.planResult.nextAction;
  if (!action) return "";
  if (action.kind === "finish_session") return "";

  if (action.kind === "pose_main_question") {
    const requiredSurface = requiredSurfaceByQuestionType[action.questionType ?? ""];
    if (requiredSurface && !options.completedSurfaces.some((surface) =>
      surface.action === requiredSurface && surface.questionId === action.questionId
    )) return "";
  }

  if (
    action.kind === "ask_follow_up"
    && options.completedSurfaces.some((surface) => surface.action in {
      open_choice: true,
      open_code_editor: true,
      open_whiteboard: true,
    })
  ) return "";

  return text;
}

export function enforceSingleFocalQuestion(text: string) {
  const normalized = text.replace(/([.!?])(?=[A-Z])/g, "$1 ");
  const sentences = normalized.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [];
  const askIndexes = sentences.flatMap((sentence, index) => {
    const isQuestion = sentence.endsWith("?");
    const isDirective = /^(?:[\w-]+,\s*)?(?:please\s+)?(?:write|implement|share|show|specify|explain|describe|compare|tell|walk)\b/i.test(sentence);
    return isQuestion || isDirective ? [index] : [];
  });
  const focalText = askIndexes.length > 1 ? sentences.slice(0, askIndexes[0] + 1).join(" ") : normalized;
  const firstQuestionMark = focalText.indexOf("?");
  let result = firstQuestionMark === -1 ? focalText : focalText.slice(0, firstQuestionMark + 1);
  const questionStart = Math.max(result.lastIndexOf(". "), result.lastIndexOf("! ")) + 2;
  const compound = result.slice(questionStart).match(
    /,?\s+and\s+(?:why|how|what|when|where|which|who|would|could|should|does|do|did|is|are|can|will|explain|describe|compare|tell|walk)\b/i,
  );
  if (compound?.index !== undefined) {
    result = `${result.slice(0, questionStart + compound.index).trimEnd()}?`;
  }
  const secondAsk = result.match(
    /[.!]\s+(?:then|also|next|and then)\s+(?:please\s+)?(?:explain|describe|compare|tell|walk|write|implement|show)\b/i,
  );
  if (secondAsk?.index !== undefined) {
    result = result.slice(0, secondAsk.index + 1);
  }
  return result.trim();
}

function words(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function truncateWords(text: string, maximumWords: number, ending: string) {
  return `${words(text).slice(0, maximumWords).join(" ").replace(/[.!?]+$/, "")}${ending}`;
}

export function enforceWordLimit(text: string, maximumWords = 45) {
  if (words(text).length <= maximumWords) return text.trim();

  const sentences = text.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [];
  const questionIndex = sentences.findIndex((sentence) => sentence.endsWith("?"));
  if (questionIndex !== -1) {
    const question = sentences[questionIndex];
    const questionWords = words(question).length;
    if (questionWords >= maximumWords) return truncateWords(question, maximumWords, "?");

    const prefix: string[] = [];
    let used = questionWords;
    for (const sentence of sentences.slice(0, questionIndex)) {
      const count = words(sentence).length;
      if (used + count > maximumWords) break;
      prefix.push(sentence);
      used += count;
    }
    return [...prefix, question].join(" ");
  }

  const kept: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    const count = words(sentence).length;
    if (used + count > maximumWords) break;
    kept.push(sentence);
    used += count;
  }
  return kept.length ? kept.join(" ") : truncateWords(text, maximumWords, ".");
}

export const CLOSING_CONFIRMATION_PROMPT =
  "We have covered all the topics planned for this session. Do you have any questions, or shall we close the session?";

export function enforceClosingSpeech(
  text: string,
  state: "none" | "started" | "question-answered" | "ended",
) {
  if (state === "ended") return "";
  if (state === "started") return CLOSING_CONFIRMATION_PROMPT;
  if (state !== "question-answered") return text;

  const answer = text.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => !sentence.endsWith("?") && !/shall we close|do you have any questions/i.test(sentence))
    .join(" ");
  return [answer, CLOSING_CONFIRMATION_PROMPT].filter(Boolean).join(" ");
}

export function isClosingConfirmation(text: string) {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (!normalized || normalized.includes("?")) return false;
  return /^(?:yes|yeah|yep|sure|ok(?:ay)?|please|go ahead|close it|end it|wrap it up|we can (?:close|end|wrap up)|(?:no|nope)(?:,? (?:questions|i(?:'m| am) good|that(?:'s| is) all))?|that(?:'s| is) all|thanks|thank you)$/.test(normalized);
}
