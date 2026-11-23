import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";

const scope = {
  orgId: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100),
  parentOrigin: z.string().min(1).max(300),
  visitorId: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
};
const visitorSchema = z.object({
  kind: z.literal("widget-visitor"), orgId: scope.orgId, parentOrigin: scope.parentOrigin,
  visitorId: scope.visitorId, expiresAt: scope.expiresAt,
}).strict();
const grantSchema = z.object({ kind: z.literal("widget-start"), ...scope }).strict();
const endSchema = z.object({
  kind: z.literal("widget-end"), ...scope, sessionId: z.string().min(1).max(100),
}).strict();

export const WIDGET_GRANT_SECONDS = 5 * 60;
export const WIDGET_VISITOR_SECONDS = 30 * 24 * 60 * 60;
export const WIDGET_END_SECONDS = 24 * 60 * 60;
export const widgetCredentialInvalid = () => new AppError("widget_token_invalid", "This widget connection expired. Please start again.", 401);

function signature(payload: string) {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  return createHmac("sha256", secret).update(`widget-v1:${payload}`).digest("base64url");
}
function sign(payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}
function verify<T>(token: string, schema: z.ZodType<T>): T {
  if (!token || token.length > 2048) throw widgetCredentialInvalid();
  const match = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]{43})$/.exec(token);
  if (!match) throw widgetCredentialInvalid();
  const expected = Buffer.from(signature(match[1]));
  const actual = Buffer.from(match[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw widgetCredentialInvalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw widgetCredentialInvalid();
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw widgetCredentialInvalid();
  const expiry = z.object({ expiresAt: scope.expiresAt }).parse(result.data);
  if (expiry.expiresAt <= Math.floor(Date.now() / 1000)) throw widgetCredentialInvalid();
  return result.data;
}

export function widgetVisitorToken(input: Omit<z.infer<typeof visitorSchema>, "kind" | "expiresAt">) {
  return sign(visitorSchema.parse({ ...input, kind: "widget-visitor", expiresAt: Math.floor(Date.now() / 1000) + WIDGET_VISITOR_SECONDS }));
}
export const readWidgetVisitor = (token: string) => verify(token, visitorSchema);
export function widgetStartGrant(input: Omit<z.infer<typeof grantSchema>, "kind" | "expiresAt">) {
  return sign(grantSchema.parse({ ...input, kind: "widget-start", expiresAt: Math.floor(Date.now() / 1000) + WIDGET_GRANT_SECONDS }));
}
export const readWidgetGrant = (token: string) => verify(token, grantSchema);
export function widgetEndToken(input: Omit<z.infer<typeof endSchema>, "kind" | "expiresAt">) {
  return sign(endSchema.parse({ ...input, kind: "widget-end", expiresAt: Math.floor(Date.now() / 1000) + WIDGET_END_SECONDS }));
}
export const readWidgetEnd = (token: string) => verify(token, endSchema);
