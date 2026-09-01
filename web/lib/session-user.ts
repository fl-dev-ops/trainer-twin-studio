import { cache } from "react";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { z } from "zod";
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { auth } from "@/lib/auth";
import { portalSlug, signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { getOrgBySlug, parseAccentColor, parseBasePath } from "@/lib/org";
import type { SessionOrg } from "@/lib/org";

const ALLOWED_ROLES: Record<string, true> = { admin: true, member: true, owner: true };
const emailSchema = z.string().email().max(255);
// RFC 8037 JWKS persisted on the org (host's Ed25519 public keys).
const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });

export type SessionUser = { id: string; name: string; email: string; role?: string };

/**
 * Organization from the learner subdomain (or membership on studio hosts) plus
 * user identity. In HOST_DELEGATED mode the host app proves the user with a
 * short-lived signed assertion header; verification is fail-closed and the
 * user is JIT-provisioned under a deterministic org-scoped id.
 */
export const resolveSessionUser = cache(async (): Promise<{
  org: SessionOrg | null;
  user: SessionUser | null;
  signInUrl: string;
}> => {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  // Host-delegated proxy sets x-tenant-slug; standalone relies on the subdomain.
  const tenantSlug = requestHeaders.get("x-tenant-slug") || portalSlug(host);

  const portalOrg = await getOrgBySlug(tenantSlug);
  if (portalOrg) {
    const org = await db.organization.findUnique({
      where: { slug: tenantSlug },
      select: {
        id: true,
        slug: true,
        authMode: true,
        hostJwks: true,
        hostIssuer: true,
        hostAudience: true,
        hostRoleMapping: true,
        config: true,
      },
    });

    if (org?.authMode === "HOST_DELEGATED") {
      return resolveHostDelegated(org, requestHeaders.get("x-host-assertion"));
    }
  }

  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { org: portalOrg, user: null, signInUrl: signInUrl(host) };

  const member = await db.member.findFirst({
    where: {
      userId: session.user.id,
      ...(portalOrg ? { organizationId: portalOrg.id } : {}),
    },
    select: { role: true, organization: { select: { id: true, slug: true, metadata: true, config: true } } },
  });
  const org: SessionOrg | null =
    portalOrg ??
    (member
      ? {
          id: member.organization.id,
          slug: member.organization.slug,
          accentColor: parseAccentColor(member.organization.metadata),
          basePath: parseBasePath(member.organization.config),
        }
      : null);

  return {
    org,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: member?.role ?? "member",
    },
    signInUrl: signInUrl(host),
  };
});

type OrgWithHostConfig = {
  id: string;
  slug: string;
  authMode: "HOST_DELEGATED" | "BUILTIN";
  hostJwks: unknown;
  hostIssuer: string | null;
  hostAudience: string | null;
  hostRoleMapping: unknown;
  config?: unknown;
};

/** Fail-closed: any verification or provisioning failure yields an anonymous session. */
async function resolveHostDelegated(
  org: OrgWithHostConfig,
  assertion: string | null,
): Promise<{ org: SessionOrg | null; user: SessionUser | null; signInUrl: string }> {
  const anonymous = { org: { id: org.id, slug: org.slug, accentColor: null, basePath: parseBasePath(org.config) }, user: null, signInUrl: "" };
  if (!org.hostJwks || !org.hostIssuer || !org.hostAudience || !assertion) {
    return anonymous;
  }
  try {
    const jwks = jwksSchema.safeParse(org.hostJwks);
    if (!jwks.success) return anonymous;
    const jwkSet = createLocalJWKSet(jwks.data as unknown as JSONWebKeySet); // shape verified above; jose needs its nominal type
    const { payload } = await jwtVerify(assertion, jwkSet, {
      issuer: org.hostIssuer,
      audience: org.hostAudience,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "iat", "exp"],
      clockTolerance: "5s",
    });

    // Assertion must be bound to this org and stay inside the host's 60s window.
    if (
      payload.org_slug !== org.slug ||
      (typeof payload.exp !== "number" || typeof payload.iat !== "number") ||
      payload.exp - payload.iat > 120
    ) {
      return { org: null, user: null, signInUrl: "" };
    }

    const rawSub = String(payload.sub || "").trim();
    if (!rawSub || rawSub.length > 255) return { org: null, user: null, signInUrl: "" };

    const emailParsed = emailSchema.safeParse(String(payload.email || "").toLowerCase().trim());
    if (!emailParsed.success) return { org: null, user: null, signInUrl: "" };
    const displayEmail = emailParsed.data;

    const displayName =
      String(payload.name || "").trim().slice(0, 100) || displayEmail.split("@")[0];
    const hostRole = String(payload.role || "user");
    const roleMap = (org.hostRoleMapping as Record<string, string>) ?? {};
    const mappedRole = roleMap[hostRole] || "member";
    const resolvedRole = ALLOWED_ROLES[mappedRole] ? mappedRole : "member";

    // Deterministic org-scoped id: prevents cross-tenant identity collisions.
    const idHash = crypto
      .createHash("sha256")
      .update(`${org.id}\0${rawSub}`)
      .digest("hex")
      .slice(0, 32);
    const internalUserId = `usr_${idHash}`;
    const internalEmail = `fed_${idHash}@internal.trainertwin.com`;

    await db.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { id: internalUserId },
        update: { name: displayName },
        create: { id: internalUserId, name: displayName, email: internalEmail, emailVerified: true },
      });
      await tx.member.upsert({
        where: {
          organizationId_externalUserId: { organizationId: org.id, externalUserId: rawSub },
        },
        update: { role: resolvedRole },
        create: {
          id: crypto.randomUUID(),
          organizationId: org.id,
          userId: u.id,
          externalUserId: rawSub,
          role: resolvedRole,
          createdAt: new Date(),
        },
      });
    });

    return {
      org: { id: org.id, slug: org.slug, accentColor: null, basePath: parseBasePath(org.config) },
      user: { id: internalUserId, name: displayName, email: displayEmail, role: resolvedRole },
      signInUrl: "",
    };
  } catch {
    return anonymous;
  }
}
