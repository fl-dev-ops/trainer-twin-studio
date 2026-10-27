import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { chatCompletionItems, gatewayProvider, meterUsage } from "@/lib/usage";

/**
 * After the call: the one model call every Workflow-run session report makes (twin, role play), with failures
 * classified for the workflow's retries. The callers own their prompts, schemas and report shapes.
 */

const AI_GATEWAY_BASE_URL = (
  process.env.AI_GATEWAY_BASE_URL ??
  process.env.OPENROUTER_BASE_URL ??
  "https://ai-gateway.vercel.sh/v1"
).replace(/\/$/, "");
const AI_GATEWAY_API_KEY =
  process.env.AI_GATEWAY_API_KEY ??
  process.env.VERCEL_OIDC_TOKEN ??
  process.env.OPENROUTER_API_KEY ??
  process.env.LLM_API_KEY ??
  "";
const REPORT_MODEL = process.env.SESSION_REPORT_MODEL ?? "google/gemini-3.7-flash";

/** Why a report could not be made. `fatal`: retrying won't help. `retryAfterMs`: wait this long first (rate limit). */
export class ReportError extends Error {
  constructor(message: string, readonly fatal: boolean, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ReportError";
  }
}

/** One structured-output call through the AI gateway; returns the reply's content. Throws a ReportError on failure. */
export async function callReportModel(input: {
  sessionId: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<unknown> {
  // shortcut: AI gateway only (the older session report also supports a direct Gemini key); add it if a deploy lacks the gateway.
  if (!AI_GATEWAY_API_KEY) throw new ReportError("AI_GATEWAY_API_KEY is not configured", true);
  const res = await fetch(`${AI_GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_GATEWAY_API_KEY}` },
    body: JSON.stringify({
      model: REPORT_MODEL,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: input.schemaName, strict: true, schema: input.schema } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new ReportError("AI gateway rate limited", false, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : 30_000);
  }
  if (!res.ok) {
    // 5xx and timeouts are worth retrying; other 4xx (bad key, bad request) are not.
    throw new ReportError(`AI gateway returned ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status < 500 && res.status !== 408);
  }
  const data = await res.json();
  await meterUsage(
    { source: "report", sessionId: input.sessionId },
    data?.id ? `gen:${data.id}` : `${input.schemaName}:${input.sessionId}:${randomUUID()}`,
    chatCompletionItems(gatewayProvider(AI_GATEWAY_BASE_URL), REPORT_MODEL, data?.usage),
  );
  return data?.choices?.[0]?.message?.content;
}

/** After the last retry: the page stops waiting. A later completion event may claim it again. */
export async function markReportFailed(sessionId: string) {
  await db.interviewSession.updateMany({ where: { id: sessionId, reportStatus: { not: "completed" } }, data: { reportStatus: "failed" } });
}
