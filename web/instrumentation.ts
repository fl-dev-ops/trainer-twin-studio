// Next.js instrumentation hook: captures server-side (nodejs runtime) request
// errors into PostHog error tracking and links them to the browser session.
export function register() {}

export async function onRequestError(err: unknown, request: {
  headers: { cookie?: string | string[] } & Record<string, unknown>;
}) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const posthog = (await import("./lib/posthog-server")).getPostHogServer();
  if (!posthog) return;

  const cookie = Array.isArray(request.headers.cookie)
    ? request.headers.cookie.join("; ")
    : request.headers.cookie;
  const match = cookie?.match(/ph_phc_.*?_posthog=([^;]+)/);
  if (match?.[1]) {
    try {
      const data = JSON.parse(decodeURIComponent(match[1]));
      await posthog.captureException(err, data.distinct_id ?? "server");
      await posthog.shutdown();
      return;
    } catch {}
  }
  await posthog.captureException(err, "server");
  await posthog.shutdown();
}
