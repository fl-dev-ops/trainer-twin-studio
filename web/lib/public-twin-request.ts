import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getOrgBySlug } from "@/lib/org";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { AppError, refusals } from "@/lib/errors";

export const PUBLIC_VISITOR_COOKIE = "tt-public-visitor";
const digest = (value: string) => {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  return createHmac("sha256", secret).update(value).digest("hex");
};

export function publicRequestHost(request: Request) {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const hostname = host.split(":")[0].toLowerCase();
  const suffix = `.${BASE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) throw refusals.notFound();
  const slug = hostname.slice(0, -suffix.length);
  if (!slug || slug.includes(".") || ["auth", "dash"].includes(slug)) throw refusals.notFound();
  const origin = request.headers.get("origin");
  if (!origin || !URL.canParse(origin) || new URL(origin).host !== host || !["http:", "https:"].includes(new URL(origin).protocol)) {
    throw new AppError("public_origin_invalid", "Start this call from the twin's public page.", 403);
  }
  return slug;
}

export async function publicRequestIdentity(request: Request, create: boolean) {
  const org = await getOrgBySlug(publicRequestHost(request));
  if (!org) throw refusals.notFound();
  const jar = await cookies();
  let visitor = jar.get(PUBLIC_VISITOR_COOKIE)?.value;
  if (!visitor || !/^[a-zA-Z0-9_-]{43}$/.test(visitor)) {
    if (!create) throw refusals.notFound();
    visitor = randomBytes(32).toString("base64url");
    jar.set(PUBLIC_VISITOR_COOKIE, visitor, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/public", maxAge: 60 * 60 * 24 * 30,
    });
  }
  // Vercel overwrites this header. Other deployments use a conservative shared bucket rather than trust spoofable IP headers.
  const ip = process.env.VERCEL ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : "shared";
  return {
    orgId: org.id,
    visitorId: digest(`visitor:${org.id}:${visitor}`),
    ipHash: digest(`public-ip:${org.id}:${ip || "shared"}`),
  };
}

export async function publicRequestBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 1024) throw refusals.invalidInput("Request is too large.");
  if (!request.body) throw refusals.invalidInput("Invalid request.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024) {
        await reader.cancel();
        throw refusals.invalidInput("Request is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw refusals.invalidInput("Invalid request.");
  }
}
