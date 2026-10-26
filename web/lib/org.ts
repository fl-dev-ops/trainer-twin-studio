import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { scenarioFitsOrg, type OrgType } from "@/lib/org-type";

export type SessionOrg = { id: string; slug: string; type: OrgType; accentColor: string | null };
export type TrainerOrg = SessionOrg & {
  role: string;
  user: { id: string; name: string; email: string };
};

// ponytail PT-1: accentColor parsed from the metadata JSON blob; move to a
// typed column on Organization when the metadata bag holds 3+ keys or needs
// DB-level queries.
export function parseAccentColor(metadata: string | null): string | null {
  try {
    const m = JSON.parse(metadata ?? "{}");
    return typeof m.accentColor === "string" ? m.accentColor : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in trainer's organization (orgLimit is 1, so at most one).
 * Null when unauthenticated or not yet part of an organization.
 */
export async function getSessionOrg(): Promise<SessionOrg | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { organization: { select: { id: true, slug: true, type: true, metadata: true } } },
  });
  if (!member) return null;
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    type: member.organization.type,
    accentColor: parseAccentColor(member.organization.metadata),
  };
}

/** The signed-in owner/admin and their organization. */
export async function getTrainerOrg(): Promise<TrainerOrg | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: {
      role: true,
      organization: { select: { id: true, slug: true, type: true, metadata: true } },
    },
  });
  if (!member || !member.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
    return null;
  }
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    type: member.organization.type,
    accentColor: parseAccentColor(member.organization.metadata),
    role: member.role,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
  };
}

/** Org by subdomain slug — for learner-facing surfaces. */
export async function getOrgBySlug(slug: string): Promise<SessionOrg | null> {
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, slug: true, type: true, metadata: true },
  });
  if (!org) return null;
  return { id: org.id, slug: org.slug, type: org.type, accentColor: parseAccentColor(org.metadata) };
}

/** Thrown when a scenario's configuration does not match its organization's type. */
export class ScenarioKindMismatchError extends Error {
  constructor(type: OrgType) {
    super(
      type === "SALES"
        ? "This organization builds role plays only"
        : "This organization builds interview scenarios only",
    );
    this.name = "ScenarioKindMismatchError";
  }
}

/** Server-side guard: a sales org stores only role plays, a technical interview org only interview scenarios. */
export async function assertScenarioFitsOrg(orgId: string, agentData: unknown): Promise<void> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { type: true } });
  if (org && !scenarioFitsOrg(org.type, agentData)) throw new ScenarioKindMismatchError(org.type);
}
