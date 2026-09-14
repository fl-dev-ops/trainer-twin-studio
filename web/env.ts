/**
 * Validated, typed environment variables (https://env.t3.gg/docs/nextjs).
 * Fails fast at build/dev startup when a required key is missing, so runtime
 * code never needs "missing key" fallback paths.
 */
import { createEnv } from "@t3-oss/env-nextjs";
import * as z from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    AI_GATEWAY_API_KEY: z.string().optional(),
    AI_GATEWAY_BASE_URL: z.url().default("https://ai-gateway.vercel.sh/v1"),
    OPENROUTER_API_KEY: z.string().default(
      process.env.AI_GATEWAY_API_KEY ||
        process.env.VERCEL_OIDC_TOKEN ||
        process.env.OPENROUTER_API_KEY ||
        "key-required"
    ),
    OPENROUTER_BASE_URL: z.url().default("https://ai-gateway.vercel.sh/v1"),
    INTERVIEW_LLM_MODEL: z.string().default("openai/gpt-4.1-mini"),
  },
  client: {
    NEXT_PUBLIC_BASE_DOMAIN: z.string().default("trainertwin.localhost"),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN,
    AI_GATEWAY_BASE_URL: process.env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1",
    OPENROUTER_API_KEY:
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN ||
      process.env.OPENROUTER_API_KEY ||
      "key-required",
    OPENROUTER_BASE_URL:
      process.env.AI_GATEWAY_BASE_URL ||
      process.env.OPENROUTER_BASE_URL ||
      "https://ai-gateway.vercel.sh/v1",
    INTERVIEW_LLM_MODEL: process.env.INTERVIEW_LLM_MODEL,
    NEXT_PUBLIC_BASE_DOMAIN: process.env.NEXT_PUBLIC_BASE_DOMAIN,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});

export function resolveAiGatewayConfig() {
  const apiKey =
    process.env.AI_GATEWAY_API_KEY ||
    process.env.VERCEL_OIDC_TOKEN ||
    process.env.OPENROUTER_API_KEY ||
    process.env.LLM_API_KEY ||
    "";
  const baseUrl = (
    process.env.AI_GATEWAY_BASE_URL ||
    process.env.OPENROUTER_BASE_URL ||
    "https://ai-gateway.vercel.sh/v1"
  ).replace(/\/$/, "");
  return { apiKey, baseUrl };
}
