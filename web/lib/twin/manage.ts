import { withLock } from "@/lib/db";
import { stableJson } from "@/lib/stable-json";
import type { Prisma } from "@/lib/generated/prisma/client";
import { beforeSettings, type BeforeSettings } from "@/lib/context-upload";
import { findTwinAgent } from "@/lib/twin-access";

const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * Changes a twin's name, description and Before settings (Configure page, copilot). Missing fields keep their value.
 * A real change snapshots the old spec and bumps the version, like a publish; no change returns the current version.
 */
export async function updateTwin(orgId: string, slug: string, patch: { name?: string; description?: string; settings?: Partial<BeforeSettings> }) {
  const found = await findTwinAgent(orgId, slug);
  // One save at a time per twin (practice rule 20): read and write under its lock.
  return withLock([`agent:${found.slug}`], async (tx) => {
  const current = await tx.agent.findUniqueOrThrow({ where: { id: found.id }, select: { name: true, version: true, data: true } });
  const previous = asRecord(current.data);
  const name = patch.name ?? current.name;
  // Before settings: read by the session screen (lib/context-upload), enforced by session start and the attach
  // route. An older `twinSettings` key is left as is; `before` wins.
  const data = {
    ...previous,
    name,
    objective: patch.description ?? previous.objective,
    before: { ...beforeSettings(current.data), ...patch.settings },
  };
  if (stableJson(data) === stableJson(current.data) && name === current.name) return { version: current.version, changed: false };
  await tx.specVersion.create({ data: { entityType: "agents", entitySlug: found.slug, version: current.version, data: json(current.data), orgId } });
  await tx.agent.update({ where: { id: found.id }, data: { name, version: current.version + 1, data: json(data) } });
  return { version: current.version + 1, changed: true };
  });
}
