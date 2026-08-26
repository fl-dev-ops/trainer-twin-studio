import {
  CodeExecutionProviderError,
  executeCode,
  type SupportedCodeExecutionLanguage,
} from "@/lib/code-execution";

const languages = new Set<SupportedCodeExecutionLanguage>([
  "html",
  "java",
  "javascript",
  "python",
  "react",
]);

export async function POST(request: Request) {
  const apiKey = process.env.ONECOMPILER_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "ONECOMPILER_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.language !== "string" ||
    !languages.has(body.language as SupportedCodeExecutionLanguage) ||
    typeof body.code !== "string" ||
    !body.code.trim() ||
    body.code.length > 20_000
  ) {
    return Response.json(
      { error: "A supported language and 1–20,000 characters of code are required" },
      { status: 400 },
    );
  }

  try {
    return Response.json(
      await executeCode({
        language: body.language as SupportedCodeExecutionLanguage,
        code: body.code,
        apiKey,
        signal: request.signal,
      }),
    );
  } catch (error) {
    if (error instanceof CodeExecutionProviderError) {
      const response = {
        quota: ["Code execution quota exceeded", 429],
        auth: ["Code execution provider authentication failed", 502],
        provider: ["Code execution failed", 502],
      }[error.kind] as [string, number];
      return Response.json({ error: response[0] }, { status: response[1] });
    }

    console.error("Code execution failed:", error);
    return Response.json({ error: "Code execution failed" }, { status: 502 });
  }
}
