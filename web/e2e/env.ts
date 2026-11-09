import { testDatabaseUrl } from "../tests/setup/test-db-url";

/**
 * What the browser tests' dev server runs with: the test database (<dev database>_test), fake outside services (no
 * email, LiveKit or chat runtime is reached), and its own build folder so it runs next to the normal dev server.
 */
export const E2E_PORT = 3999;
export const E2E_BASE = "trainertwin.localhost";
export const e2eUrl = (host: string, path = "/") => `http://${host}.${E2E_BASE}:${E2E_PORT}${path}`;

export function e2eServerEnv(): Record<string, string> {
  const db = testDatabaseUrl();
  if (!db) throw new Error("DATABASE_URL in web/.env must be a local database to derive the test one");
  return {
    NEXT_DIST_DIR: ".next-e2e",
    DATABASE_URL: db,
    DATABASE_URL_UNPOOLED: db,
    RESEND_API_KEY: "",
    LIVEKIT_URL: "wss://livekit.test",
    NEXT_PUBLIC_LIVEKIT_URL: "wss://livekit.test",
    CHAT_URL: "http://chat.test",
    RAZORPAY_KEY_ID: "rzp_test_fake",
    RAZORPAY_KEY_SECRET: "fake-secret",
    RAZORPAY_WEBHOOK_SECRET: "test-webhook-secret",
  };
}
