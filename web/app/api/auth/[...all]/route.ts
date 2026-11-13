import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { errorResponse, refusals } from "@/lib/errors";

const handler = toNextJsHandler(auth);

/**
 * The only Better Auth routes the app uses (specs/people.md rule 13). Everything else it mounts (organization members,
 * API keys, passwords, anything a later version adds) is not_found here, before Better Auth runs. Server code calls
 * auth.api directly and isn't affected.
 */
export const OPEN_AUTH_ROUTES = new Set([
  "GET /get-session",
  "POST /sign-out",
  "GET /ok",
  "GET /error",
  "POST /email-otp/send-verification-otp",
  "POST /sign-in/email-otp",
  "POST /sign-in/social",
  "GET /callback/google",
  "POST /callback/google",
  "POST /organization/set-active",
  "POST /update-user",
]);

const routeOf = (request: Request) => `${request.method} ${new URL(request.url).pathname.replace(/^\/api\/auth/, "").replace(/\/+$/, "")}`;

async function open(request: Request) {
  const route = routeOf(request);
  if (!OPEN_AUTH_ROUTES.has(route)) return errorResponse(refusals.notFound());
  if (route === "POST /update-user") {
    // Your own name only (the picture would take any string).
    const body: unknown = await request.clone().json().catch(() => null);
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    if (keys.length !== 1 || keys[0] !== "name") return errorResponse(refusals.invalidInput("Only your name can be changed here."));
  }
  return null;
}

export async function GET(request: Request) {
  return (await open(request)) ?? handler.GET(request);
}

export async function POST(request: Request) {
  return (await open(request)) ?? handler.POST(request);
}

const closed = () => errorResponse(refusals.notFound());
export { closed as PATCH, closed as PUT, closed as DELETE, closed as OPTIONS };
