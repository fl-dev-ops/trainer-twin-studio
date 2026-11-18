import { AppError, refusals } from "@/lib/errors";
import { widgetAgent, widgetPageOrg } from "@/lib/widget-access";
import { publicTwinSettings } from "@/lib/public-twin-settings";
import { trainerProfile } from "@/lib/pages/learner";

function scriptData(value: object) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function GET(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const org = await widgetPageOrg(request);
    const { agentId } = await context.params;
    const parentOrigin = new URL(request.url).searchParams.get("parentOrigin") ?? "";
    const mode = new URL(request.url).searchParams.get("mode") ?? "floating";
    if (mode !== "floating" && mode !== "inline") throw refusals.invalidInput("Invalid widget mode.");
    const { agent, settings } = await widgetAgent(org.id, agentId, parentOrigin);
    const trainer = await trainerProfile(agent.personaId);
    const config = {
      agentId, parentOrigin, mode, name: agent.name, trainerName: agent.persona.name,
      photoUrl: trainer.photoUrl, welcome: settings.welcome, accentColor: settings.accentColor,
      maxSeconds: publicTwinSettings(agent.data).maxSeconds,
      livekitUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL || "",
    };
    const csp = [
      `frame-ancestors ${settings.allowedOrigins.join(" ")}`,
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' https: data:",
      "connect-src 'self' https: wss:", "media-src 'self' blob:", "font-src 'self'", "base-uri 'none'", "form-action 'none'",
    ].join("; ");
    return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Talk to an AI twin</title><link rel="stylesheet" href="/widgets/voice-v1.css"></head>
<body><div id="trainertwin-widget"></div><script id="trainertwin-config" type="application/json">${scriptData(config)}</script>
<script src="/widgets/voice-v1.js" defer></script></body></html>`, {
      headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": csp,
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "microphone=(self), camera=(), display-capture=(), geolocation=()",
      },
    });
  } catch (error) {
    if (!(error instanceof AppError)) console.error("Widget page failed", error);
    return new Response("This twin is not available on this website.", {
      status: error instanceof AppError ? error.status : 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" },
    });
  }
}
