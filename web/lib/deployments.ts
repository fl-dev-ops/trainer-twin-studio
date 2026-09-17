import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

export type DeliveryMode = "chat" | "voice";

export function deploymentPublicKey() {
  return `tt_pub_${randomBytes(24).toString("base64url")}`;
}

export async function ensureDeployment(orgId: string, agentId: string) {
  const existing = await db.deployment.findUnique({
    where: { orgId_agentId: { orgId, agentId } },
  });
  if (existing) return existing;
  return db.deployment.create({
    data: { orgId, agentId, publicKey: deploymentPublicKey() },
  }).catch(async (error) => {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return db.deployment.findUniqueOrThrow({ where: { orgId_agentId: { orgId, agentId } } });
    }
    throw error;
  });
}

export function deploymentAllowsMode(allowedModes: string, mode: DeliveryMode) {
  return allowedModes.split(",").map((value) => value.trim()).includes(mode);
}

export function deploymentAllowsOrigin(allowedOrigins: unknown, origin: string | null) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
  return Boolean(origin && allowedOrigins.includes(origin));
}
