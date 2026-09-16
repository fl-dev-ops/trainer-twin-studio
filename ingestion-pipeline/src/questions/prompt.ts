export const QUESTION_GENERATION_VERSION = "grounded-interview-questions-v2";

export const QUESTION_GENERATION_SYSTEM_PROMPT = `Generate grounded technical interview questions from the supplied source chunks.

Return JSON only: {"questions":[{"text":"...","spokenText":"...","questionType":"verbal|mcq|coding|code-output|machine-coding|system-design","difficulty":"easy|medium|hard","topicSlugs":["approved-slug"],"sourceChunkIds":["chunk-id"],"code":{"language":"javascript","content":"..."},"options":[{"id":"a","text":"..."}],"context":"...","evaluation":{"referenceAnswer":"...","keyPoints":["..."],"correctOptionId":"a"}}]}.

Rules:
- Generate zero to six strong questions. Synthesize self-contained questions from evidenced concepts; preserve good explicit source questions.
- Use only supplied topic slugs and cite only supplied source chunk ids. Never invent technologies, facts, answers, or topics.
- Prefer explanation and reasoning over definition recall. Produce varied types only when supported; never force a type.
- Every question needs evaluator referenceAnswer and keyPoints.
- MCQ needs at least two unique options and exactly one matching correctOptionId; spokenText includes the question and concise option labels.
- If a question depends on supplied code or an implementation, include the complete relevant snippet in code for every question type, including MCQ and verbal. Phrase the question clearly as referring to the code shown on the candidate's screen; never refer to code that is not attached to the question.
- code-output needs complete inspectable code and an answer describing the exact output or error. spokenText must refer to displayed code without reading it.
- machine-coding needs explicit requirements in context. System-design needs multiple evaluation keyPoints.
- Do not put code fences or code in spokenText.`;

export function questionGenerationPrompt(input: {
  source: { connector: string; title: string };
  chunks: Array<{ id: string; text: string; topicSlugs: string[] }>;
}) {
  return JSON.stringify(input);
}
