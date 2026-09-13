import { timingSafeEqual } from "node:crypto";

/** eve SessionAuthContext shape (structurally identical; type not publicly exported). */
export interface SessionAuthContext {
  attributes: Readonly<Record<string, string | readonly string[]>>;
  authenticator: string;
  principalId: string;
  principalType: string;
}

/**
 * Shared studio principal parser. The copilot/studio Basic scheme is
 * `base64(orgId:COPILOT_SERVICE_SECRET)`; it authenticates an ORGANIZATION
 * principal that rides through eve sessions as session auth attributes.
 */
export function studioPrincipal(request: Request): SessionAuthContext | null {
  const encoded = request.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!encoded || !secret) return null;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  const orgId = decoded.slice(0, separator);
  const supplied = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  return {
    attributes: { orgId },
    authenticator: "studio",
    principalId: orgId,
    principalType: "organization",
  };
}
