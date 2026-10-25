import { timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import { type AuthFn, localDev } from "eve/channels/auth";

function studioOrganization(): AuthFn<Request> {
  return (request) => {
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

    // userId is set by the web proxy (same request that carries the secret); used for usage attribution.
    const userId = request.headers.get("x-trainertwin-user-id")?.trim() ?? "";
    return {
      attributes: { orgId, ...(userId ? { userId } : {}) },
      authenticator: "studio",
      principalId: orgId,
      principalType: "organization",
    };
  };
}

export default eveChannel({
  auth: [studioOrganization(), localDev()],
});
