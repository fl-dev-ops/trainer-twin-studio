import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import {
  type SessionReport,
  SESSION_REPORT_JSON_SCHEMA,
  isSessionReport,
} from "@/lib/session-report";

const OPENROUTER_BASE_URL = (
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
).replace(/\/$/, "");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const REPORT_MODEL = process.env.SESSION_REPORT_MODEL ?? "google/gemini-3.7-flash";

export type SessionImageAttachment = {
  mimeType: string;
  base64: string;
  description?: string;
};

const SYSTEM_PROMPT = `You are an expert executive interviewer, engineering leader, and communication coach evaluating a completed interview/roleplay session.
Analyze the provided session transcript between the Trainer (interviewer) and the Learner (candidate), along with any attached architectural whiteboard sketches, code snapshots, or diagram images.

Multimodal Processing Instructions:
- If whiteboard drawings, architectural sketches, or UI/code screenshots are provided, analyze them closely.
- Evaluate whether the learner's spoken explanation matched their visual diagrams or architectural trade-offs.
- Reference any visual diagrams in the key moments if relevant.

Generate a structured evaluation report matching the exact schema:
1. summary: A 2-3 sentence precise narrative summary of how the learner performed, the baseline established, visual/architectural clarity, and how well they isolated trade-offs or causation.
2. summaryTags: 2 to 4 concise tags (e.g., "Baseline established", "Method explained", "Attribution unresolved", "Architecture diagrammed").
3. keyMoments: Exactly 3 high-impact conversation moments:
   - number: "01", "02", "03"
   - timestamp: approximate "MM:SS" (estimate from dialogue progression, e.g. "2:18", "5:06", "8:41")
   - seconds: integer seconds corresponding to timestamp
   - title: short concept title (e.g., "Claim and baseline", "Measurement method", "Causal confidence")
   - quote: verbatim or near-verbatim quote spoken by the learner
   - description: 1 sentence explaining why this moment was notable or what it demonstrated
4. focusNextTime: A single actionable coaching recommendation for what the learner should improve in their next session.
5. score: An optional holistic score between 0 and 100 based on role mastery.`;

export async function generateSessionReport(
  sessionId: string,
  options?: { images?: SessionImageAttachment[] }
): Promise<SessionReport | null> {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      agentSlug: true,
      personaSlug: true,
      contextName: true,
      transcript: true,
      evidence: true,
      report: true,
      reportStatus: true,
      user: { select: { name: true, email: true } },
    },
  });

  if (!session) return null;

  // If already generated, return cached report
  if (session.reportStatus === "completed" && isSessionReport(session.report)) {
    return session.report;
  }

  const rawTranscript = Array.isArray(session.transcript) ? session.transcript : [];
  if (rawTranscript.length === 0) {
    return null;
  }

  const transcriptText = rawTranscript
    .map((turn: unknown) => {
      if (typeof turn !== "object" || turn === null) return "";
      const t = turn as { role?: string; speaker?: string; text?: string };
      const speaker = t.role === "user" || t.speaker === "learner" ? "Learner" : "Trainer";
      return `${speaker}: ${t.text ?? ""}`;
    })
    .filter(Boolean)
    .join("\n\n");

  await db.interviewSession.update({
    where: { id: sessionId },
    data: { reportStatus: "generating" },
  });

  try {
    const learnerName = session.user?.name || "Learner";
    const userPrompt = `Learner name: ${learnerName}
Scenario: ${session.agentSlug}
Persona: ${session.personaSlug}
${session.contextName ? `Context document: ${session.contextName}` : ""}

--- SESSION TRANSCRIPT ---
${transcriptText}`;

    const images = options?.images ?? [];
    let parsed: unknown;

    if (OPENROUTER_API_KEY) {
      // Format content parts with optional image processing
      const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: "text", text: userPrompt },
      ];

      for (const img of images) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mimeType};base64,${img.base64}`,
          },
        });
      }

      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: REPORT_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: images.length > 0 ? contentParts : userPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "session_report",
              strict: true,
              schema: SESSION_REPORT_JSON_SCHEMA,
            },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        throw new Error(`OpenRouter returned ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      parsed = typeof content === "string" ? JSON.parse(content) : null;
    } else if (GEMINI_API_KEY) {
      // Direct Google Gemini API with multimodal parts
      const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
        { text: userPrompt },
      ];

      for (const img of images) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          },
        });
      }

      // Try Gemini 3.7 Flash, falling back to 2.5 Flash
      const modelName = process.env.GEMINI_DIRECT_MODEL ?? "gemini-3.7-flash";
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: SESSION_REPORT_JSON_SCHEMA,
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        throw new Error(`Gemini API returned ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      parsed = typeof text === "string" ? JSON.parse(text) : null;
    } else {
      throw new Error("Neither OPENROUTER_API_KEY nor GEMINI_API_KEY is configured");
    }

    if (!isSessionReport(parsed)) {
      throw new Error("LLM output did not match SessionReport schema");
    }

    const keyMomentsWithIds = Array.isArray(parsed.keyMoments)
      ? parsed.keyMoments.map((m, idx) => ({
          ...m,
          id: m.id || `${sessionId}-m${idx + 1}`,
        }))
      : [];

    const finalReport: SessionReport = {
      ...parsed,
      keyMoments: keyMomentsWithIds,
      generatedAt: new Date().toISOString(),
    };

    await db.interviewSession.update({
      where: { id: sessionId },
      data: {
        report: finalReport as unknown as Prisma.InputJsonValue,
        reportStatus: "completed",
      },
    });

    return finalReport;
  } catch (error) {
    console.error("Failed to generate session report:", error);
    await db.interviewSession.update({
      where: { id: sessionId },
      data: { reportStatus: "failed" },
    }).catch(() => {});
    return null;
  }
}
