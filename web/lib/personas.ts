import { db, isUniqueViolation, withLock } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { newPersonaSettings, personaFromStored, personaInputSchema, slugify, storedFromPersona, storedTraits } from "@/lib/persona";
import { stableJson } from "@/lib/stable-json";
import { avatarPhotoUrl, selectOwnPersonaVoice } from "@/lib/twin/avatar";
import { attachPersonaVoice, VoiceError } from "@/lib/voices";

/**
 * Personas of an org as the Persona Library shows them: role-play personas (isOwn = false) and the trainer's own
 * persona (isOwn = true), which a role play can also use. Own personas are never created here (they come from the
 * trainer's setup) and their photo comes from Twin's brain.
 *
 * A persona is referenced, never copied: agents point at it, and each session freezes the persona data and voice it
 * started with (compiledSnapshot.persona, InterviewSession.resolvedVoiceId). Saving here affects later sessions only.
 */

export class PersonaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const select = {
  id: true, slug: true, name: true, version: true, data: true, settings: true, isOwn: true, updatedAt: true,
  avatar: { select: { s3ImageKey: true, s3VideoKey: true, updatedAt: true } },
  voice: { select: { id: true, name: true } },
  // Every agent it plays, a role play's extra personas included (AgentPersona).
  agentLinks: { where: { agent: { archivedAt: null } }, select: { agent: { select: { slug: true, name: true, kind: true } } }, orderBy: { agent: { name: "asc" } } },
} as const;

type Row = Prisma.PersonaGetPayload<{ select: typeof select }>;

function view(row: Row) {
  return {
    slug: row.slug,
    isOwn: row.isOwn,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    persona: personaFromStored(row.name, row.data),
    /** Earlier editor settings and recorded style, still used by the brief; shown read-only. */
    traits: storedTraits(row.data, row.settings),
    photoUrl: avatarPhotoUrl(row.slug, row.avatar),
    hasVideo: Boolean(row.avatar?.s3VideoKey),
    voice: row.voice ? { id: row.voice.id, name: row.voice.name } : null,
    /** Active agents using this persona: an edit applies to their next sessions. */
    usedBy: row.agentLinks.map(({ agent }) => ({ slug: agent.slug, name: agent.name, kind: agent.kind })),
  };
}
export type PersonaView = ReturnType<typeof view>;

/** The org's personas: the trainer's own first, then role-play personas by name. */
export async function listPersonas(orgId: string): Promise<PersonaView[]> {
  const rows = await db.persona.findMany({ where: { orgId }, orderBy: [{ isOwn: "desc" }, { name: "asc" }], select });
  return rows.map(view);
}

/** One of the org's personas (own or role-play), or null. Global personas keep the spec page. */
export async function getPersona(orgId: string, slug: string): Promise<PersonaView | null> {
  const row = await db.persona.findFirst({ where: { orgId, slug }, select });
  return row ? view(row) : null;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

function voiceRefusal(error: unknown): never {
  if (error instanceof VoiceError) throw new PersonaError(error.message, error.status);
  throw error;
}

/**
 * Creates (no slug) or updates a persona from the short form, together with its voice selection: one transaction, so
 * Save commits all of it or nothing. Updates replace only name, role and description, keeping every other stored key,
 * and are versioned like spec edits (SpecVersion); an unchanged form makes no new version.
 */
export async function savePersona(orgId: string, input: unknown, slug?: string): Promise<{ slug: string; version: number }> {
  const parsed = personaInputSchema.safeParse(input);
  if (!parsed.success) throw new PersonaError(parsed.error.issues[0]?.message ?? "Invalid persona");
  const { voiceId, ...fields } = parsed.data;
  return slug ? updatePersona(orgId, slug, fields, voiceId) : createPersona(orgId, fields, voiceId);
}

async function createPersona(orgId: string, fields: ReturnType<typeof personaFromStored>, voiceId?: string) {
  const base = slugify(fields.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    let target = base;
    for (let n = 2; await db.persona.findFirst({ where: { orgId, slug: target }, select: { id: true } }); n++) target = `${base}-${n}`;
    try {
      return await db.$transaction(async (tx) => {
        const created = await tx.persona.create({
          data: { orgId, slug: target, name: fields.name, version: 1, isOwn: false, data: json(storedFromPersona(target, fields)), settings: newPersonaSettings() },
        });
        if (voiceId) await attachPersonaVoice(orgId, target, voiceId, tx);
        return { slug: created.slug, version: created.version };
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue; // another save took the slug between the check and the insert
      voiceRefusal(error);
    }
  }
  throw new PersonaError("Could not pick a unique name for this persona. Try again.", 409);
}

async function updatePersona(orgId: string, slug: string, fields: ReturnType<typeof personaFromStored>, voiceId?: string) {
  const persona = await db.persona.findFirst({ where: { orgId, slug }, select: { isOwn: true, voiceId: true } });
  if (!persona) throw new PersonaError("Persona not found", 404);
  let version = 0;
  const writeDefinition = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "Persona" WHERE "orgId" = ${orgId} AND slug = ${slug} FOR UPDATE`;
    const existing = await tx.persona.findFirst({ where: { orgId, slug }, select: { id: true, name: true, version: true, data: true } });
    if (!existing) throw new PersonaError("Persona not found", 404);
    const data = storedFromPersona(slug, fields, existing.data);
    version = existing.version;
    if (existing.name === fields.name && stableJson(data) === stableJson(existing.data)) return;
    version = existing.version + 1;
    await tx.specVersion.create({ data: { entityType: "personas", entitySlug: slug, version: existing.version, data: json(existing.data), orgId } });
    await tx.persona.update({ where: { id: existing.id }, data: { name: fields.name, version, data: json(data) } });
  };
  try {
    // The trainer's own voice goes through the twin path: it also retires twins' copied voice overrides.
    if (persona.isOwn && voiceId && voiceId !== persona.voiceId) {
      await selectOwnPersonaVoice(orgId, slug, voiceId, undefined, writeDefinition);
    } else {
      await db.$transaction(async (tx) => {
        await writeDefinition(tx);
        if (voiceId) await attachPersonaVoice(orgId, slug, voiceId, tx);
      });
    }
  } catch (error) {
    voiceRefusal(error);
  }
  return { slug, version };
}

/** A persona an agent still uses cannot be removed (no automatic detach or fallback). */
export class PersonaInUseError extends PersonaError {
  constructor(readonly agents: number) {
    super(`This persona is used by ${agents} ${agents === 1 ? "agent" : "agents"}. Choose another persona for ${agents === 1 ? "it" : "them"} first.`, 409);
  }
}

/** Removes a persona's row and history if no agent (archived included) uses it. Returns its source files to clean up. */
export async function removePersonaRecord(orgId: string, slug: string) {
  return withLock([`persona:${orgId}:${slug}`], async (tx) => {
    // Locks the row: a concurrent agent insert/update referencing it waits on its key lock.
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Persona" WHERE "orgId" = ${orgId} AND slug = ${slug} FOR UPDATE`;
    if (!row) throw new PersonaError("Persona not found", 404);
    // Any agent that may speak as it: its main persona, or one of a role play's personas (archived included).
    const agents = await tx.agent.count({ where: { OR: [{ personaId: row.id }, { personas: { some: { personaId: row.id } } }] } });
    if (agents) throw new PersonaInUseError(agents);
    const sources = await tx.personaSource.findMany({ where: { personaId: row.id, orgId }, select: { s3Key: true } });
    await tx.specVersion.deleteMany({ where: { entityType: "personas", entitySlug: slug, orgId } });
    await tx.persona.delete({ where: { id: row.id } });
    return { personaId: row.id, sourceKeys: sources.map((source) => source.s3Key) };
  });
}
