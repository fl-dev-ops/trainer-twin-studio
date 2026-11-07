// Next.js instrumentation hook: captures server-side (nodejs runtime) request
// errors into PostHog error tracking and links them to the browser session.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Node's fetch drops an idle connection after 4 s; twin turns are 30-40 s apart, so every Chroma Cloud
  // query (us-east) paid a fresh connect + TLS: ~1.65 s instead of ~0.3 s. Keep idle connections for 60 s.
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 }));
}

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
