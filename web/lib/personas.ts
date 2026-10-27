import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { personaFromStored, personaInputSchema, slugify, storedFromPersona, type PersonaInput } from "@/lib/persona";
import { avatarPhotoUrl } from "@/lib/twin/avatar";

/** Role-play personas (isOwn = false) of an org: the characters learners talk to. */

export class PersonaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const select = {
  id: true, slug: true, name: true, version: true, data: true, settings: true, isOwn: true, updatedAt: true,
  avatar: { select: { s3ImageKey: true, s3VideoKey: true, updatedAt: true } },
  voice: { select: { id: true, name: true } },
} as const;

type Row = Prisma.PersonaGetPayload<{ select: typeof select }>;

function view(row: Row) {
  return {
    slug: row.slug,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    persona: personaFromStored(row.name, row.data, row.settings),
    photoUrl: avatarPhotoUrl(row.slug, row.avatar),
    hasVideo: Boolean(row.avatar?.s3VideoKey),
    voice: row.voice ? { id: row.voice.id, name: row.voice.name } : null,
  };
}
export type PersonaView = ReturnType<typeof view>;

export async function listRolePlayPersonas(orgId: string): Promise<PersonaView[]> {
  const rows = await db.persona.findMany({ where: { orgId, isOwn: false }, orderBy: { name: "asc" }, select });
  return rows.map(view);
}

/** One role-play persona, or null (missing, or someone's own persona, which keeps its own page). */
export async function getRolePlayPersona(orgId: string, slug: string): Promise<PersonaView | null> {
  const row = await db.persona.findFirst({ where: { orgId, slug }, select });
  return row && !row.isOwn ? view(row) : null;
}

/** Creates (no slug) or updates a role-play persona. Updates are versioned like spec edits (SpecVersion). */
export async function savePersona(orgId: string, input: unknown, slug?: string): Promise<{ slug: string; version: number }> {
  const parsed = personaInputSchema.safeParse(input);
  if (!parsed.success) throw new PersonaError(parsed.error.issues[0]?.message ?? "Invalid persona");
  const value: PersonaInput = parsed.data;

  if (!slug) {
    const base = slugify(value.name);
    let target = base;
    for (let n = 2; await db.persona.findFirst({ where: { orgId, slug: target }, select: { id: true } }); n++) target = `${base}-${n}`;
    const stored = storedFromPersona(target, value);
    const created = await db.persona.create({
      data: { orgId, slug: target, name: value.name, version: 1, isOwn: false, data: stored.data as Prisma.InputJsonValue, settings: stored.settings },
    });
    return { slug: created.slug, version: created.version };
  }

  const existing = await db.persona.findFirst({ where: { orgId, slug }, select: { id: true, version: true, data: true, isOwn: true } });
  if (!existing || existing.isOwn) throw new PersonaError("Persona not found", 404);
  const stored = storedFromPersona(slug, value, existing.data);
  const version = existing.version + 1;
  await db.$transaction([
    db.specVersion.create({ data: { entityType: "personas", entitySlug: slug, version: existing.version, data: existing.data as Prisma.InputJsonValue, orgId } }),
    db.persona.update({ where: { id: existing.id }, data: { name: value.name, version, data: stored.data as Prisma.InputJsonValue, settings: stored.settings } }),
  ]);
  return { slug, version };
}
