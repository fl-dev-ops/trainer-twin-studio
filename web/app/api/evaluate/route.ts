import { createHmac } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NoObjectGeneratedError, Output, generateText, type ModelMessage } from "ai";
import { z } from "zod";
import {
  readWhiteboardUpload,
  validateWhiteboardObject,
  verifyParticipantRequest,
  whiteboardSigningSecret,
} from "@/lib/whiteboard-submission";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const LOG_PREFIX = "[LLM:whiteboard-evaluation]";
const shortItem = z.string().trim().min(1).max(120);
const evaluationSchema = z.object({
  drawingSummary: z.object({
    components: z.array(shortItem).max(8),
    connections: z.array(shortItem).max(8),
    flow: z.array(shortItem).max(8),
    unclearAreas: z.array(shortItem).max(8),
  }),
  visualEvaluation: z.object({
    result: z.enum(["correct", "partial", "incorrect", "unclear"]),
    strengths: z.array(z.string().trim().min(1).max(240)).max(3),
    gaps: z.array(z.string().trim().min(1).max(240)).max(3),
    evidence: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1),
  }),
});

const evaluationRequestSchema = z.object({
  question: z.string().trim().min(1),
  roomName: z.string(),
  participantIdentity: z.string(),
  questionId: z.string(),
  revision: z.number().int().nonnegative(),
  imageSha256: z.string(),
  imageBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  s3Key: z.string(),
});

const SYSTEM_PROMPT =
  "You evaluate a system-design whiteboard image for a technical interview. " +
  "First report only visible components, labels, connections, direction and unclear areas. " +
  "Then assess how well the visible design addresses the question. Do not invent unlabeled " +
  "services, requirements, tradeoffs, scale assumptions or candidate reasoning. Keep every field concise.";

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "Whiteboard evaluation is not configured" }, { status: 500 });
  }

  const parsed = evaluationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid whiteboard evaluation request" }, { status: 400 });
  }
  const input = parsed.data;
  if (
    !validateWhiteboardObject(input) ||
    !(await verifyParticipantRequest(request, input.roomName, input.participantIdentity))
  ) {
    return Response.json({ error: "Whiteboard evaluation is not authorized" }, { status: 403 });
  }

  const imageBytes = await readWhiteboardUpload(input);
  if (!imageBytes) {
    return Response.json({ error: "Whiteboard upload could not be verified" }, { status: 409 });
  }
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!pngSignature.every((byte, index) => imageBytes[index] === byte)) {
    return Response.json({ error: "Invalid PNG image" }, { status: 400 });
  }

  const messages: ModelMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: `Interview question:\n${input.question}` },
      { type: "file", mediaType: "image/png", data: imageBytes },
    ],
  }];
  const modelName = process.env.WHITEBOARD_VISION_MODEL?.trim() || "openai/gpt-4o";
  const startedAt = Date.now();
  console.info(`${LOG_PREFIX} started model=${modelName} question_id=${input.questionId}`);
  try {
    const result = await generateText({
      model: createOpenRouter({ apiKey })(modelName),
      system: SYSTEM_PROMPT,
      messages,
      output: Output.object({ schema: evaluationSchema }),
    });
    const payload = JSON.stringify({
      version: 1,
      roomName: input.roomName,
      participantIdentity: input.participantIdentity,
      questionId: input.questionId,
      revision: input.revision,
      imageSha256: input.imageSha256,
      imageBytes: input.imageBytes,
      s3Key: input.s3Key,
      evaluatedAt: Date.now(),
      evaluationStatus: "completed",
      ...result.output,
    });
    const signature = createHmac("sha256", whiteboardSigningSecret()).update(payload).digest("hex");
    console.info(
      `${LOG_PREFIX} completed model=${modelName} question_id=${input.questionId} elapsed_ms=${Date.now() - startedAt}`,
    );
    return Response.json({ payload, signature });
  } catch (error) {
    console.error(
      `${LOG_PREFIX} ${NoObjectGeneratedError.isInstance(error) ? "invalid_output" : "failed"} model=${modelName} question_id=${input.questionId} elapsed_ms=${Date.now() - startedAt}`,
      error,
    );
    const payload = JSON.stringify({
      version: 1,
      roomName: input.roomName,
      participantIdentity: input.participantIdentity,
      questionId: input.questionId,
      revision: input.revision,
      imageSha256: input.imageSha256,
      imageBytes: input.imageBytes,
      s3Key: input.s3Key,
      evaluatedAt: Date.now(),
      evaluationStatus: "failed",
    });
    const signature = createHmac("sha256", whiteboardSigningSecret()).update(payload).digest("hex");
    return Response.json({ payload, signature });
  }
}
