import yaml from "js-yaml";
import { db } from "@/lib/db";
import { clientPersonaSchema, personaDataFromForm } from "@/lib/client-persona";
import { isClientPersonaData } from "@/lib/roleplay";
import { saveSpec } from "@/lib/specs";

export class ClientPersonaError extends Error {}

const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "persona";

/** Creates (no slug) or updates a client persona through the normal versioned persona save. */
export async function saveClientPersona(orgId: string, input: unknown, slug?: string): Promise<{ slug: string; version: number }> {
  const parsed = clientPersonaSchema.safeParse(input);
  if (!parsed.success) throw new ClientPersonaError(parsed.error.issues[0]?.message ?? "Invalid persona");
  const form = parsed.data;

  let existing: Record<string, unknown> = {};
  let target = slug;
  if (slug) {
    const row = await db.persona.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { data: true } });
    if (!row || !isClientPersonaData(row.data)) throw new ClientPersonaError("Persona not found");
    existing = row.data as Record<string, unknown>;
  } else {
    const base = slugify(form.name);
    target = base;
    for (let n = 2; await db.persona.findUnique({ where: { orgId_slug: { orgId, slug: target } }, select: { id: true } }); n++) {
      target = `${base}-${n}`;
    }
  }

  if (form.voiceId) {
    const voice = await db.voice.findFirst({
      where: { id: form.voiceId, status: "ready", OR: [{ orgId }, { orgId: null }] },
      select: { id: true },
    });
    if (!voice) throw new ClientPersonaError("Voice is not available");
  }
  // Only this org's documents and sources can be attached.
  const [documents, sources] = await Promise.all([
    db.knowledgeDocument.findMany({ where: { id: { in: form.knowledge.documentIds }, kb: { orgId } }, select: { id: true } }),
    db.knowledgeSource.findMany({ where: { id: { in: form.knowledge.sourceIds }, orgId }, select: { id: true } }),
  ]);
  form.knowledge = { documentIds: documents.map((doc) => doc.id), sourceIds: sources.map((source) => source.id) };

  // JSON round trip drops undefined fields, which YAML cannot dump.
  const data = JSON.parse(JSON.stringify(personaDataFromForm(form, existing)));
  const result = await saveSpec(
    "personas",
    target!,
    yaml.dump({ schema_version: 1, kind: "persona", persona: { ...data, id: target } }, { lineWidth: -1, noRefs: true }),
    orgId,
  );
  return { slug: target!, version: result.version ?? 1 };
}
