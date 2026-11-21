import "dotenv/config";
import { testDatabaseUrl } from "../tests/setup/test-db-url";

/**
 * What the browser tests' dev server runs with: the test database (<dev database>_test), fake outside services (no
 * email, LiveKit or chat runtime is reached), and its own build folder so it runs next to the normal dev server.
 */
export const E2E_PORT = 3999;
export const E2E_BASE = "trainertwin.localhost";
export const e2eUrl = (host: string, path = "/") => `http://${host}.${E2E_BASE}:${E2E_PORT}${path}`;

// Opt-in voice transport smoke test: start `livekit-server --dev` locally before running Playwright.
export const localVoice = process.env.E2E_LOCAL_LIVEKIT === "1";
export const localLiveKit = { url: "http://127.0.0.1:7880", key: "devkey", secret: "secret" };

export function e2eServerEnv(): Record<string, string> {
  const db = testDatabaseUrl();
  if (!db) throw new Error("DATABASE_URL in web/.env must be a local database to derive the test one");
  return {
    NEXT_DIST_DIR: ".next-e2e",
    DATABASE_URL: db,
    DATABASE_URL_UNPOOLED: db,
    NEXT_PUBLIC_BASE_DOMAIN: E2E_BASE,
    BETTER_AUTH_URL: e2eUrl("auth"),
    RESEND_API_KEY: "",
    TTS_SERVICE_URL: "http://127.0.0.1:3997",
    TTS_SERVICE_KEY: "e2e-tts-service",
    TTS_APP_KEY: "e2e-tts-app",
    AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9100",
    AWS_ACCESS_KEY_ID: "S3RVER",
    AWS_SECRET_ACCESS_KEY: "S3RVER",
    AWS_REGION: "us-east-1",
    S3_BUCKET: "olga-local",
    AWS_S3_BUCKET: "olga-local",
    S3_BASE_PREFIX: "voice-e2e",
    AI_GATEWAY_API_KEY: "",
    OPENROUTER_API_KEY: "",
    CEREBRAS_API_KEY: "",
    LIVEKIT_URL: localVoice ? localLiveKit.url.replace(/^http/, "ws") : "wss://livekit.test",
    NEXT_PUBLIC_LIVEKIT_URL: localVoice ? localLiveKit.url.replace(/^http/, "ws") : "wss://livekit.test",
    LIVEKIT_API_KEY: localVoice ? localLiveKit.key : "e2e-livekit-key",
    LIVEKIT_API_SECRET: localVoice ? localLiveKit.secret : "e2e-only-livekit-secret-not-for-deploy",
    CHAT_URL: localVoice ? "http://127.0.0.1:3996" : "http://chat.test",
    COPILOT_SERVICE_SECRET: "e2e-only-chat-secret",
    METEROID_API_URL: "http://127.0.0.1:3998/api/v1",
    METEROID_API_KEY: "e2e-meteroid",
    METEROID_WEBHOOK_SECRET: "whsec_dGVzdC1tZXRlcm9pZC1zZWNyZXQ=",
    RAZORPAY_ENABLED: "true", // switched off in phase 1 (lib/razorpay.ts); its browser tests switch it on
    RAZORPAY_KEY_ID: "rzp_test_fake",
    RAZORPAY_KEY_SECRET: "fake-secret",
    RAZORPAY_WEBHOOK_SECRET: "test-webhook-secret",
  };
}
