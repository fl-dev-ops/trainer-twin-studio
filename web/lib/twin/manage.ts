import { db } from "@/lib/db";
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
  const current = await db.agent.findUniqueOrThrow({ where: { id: found.id }, select: { version: true, data: true } });
  const previous = asRecord(current.data);
  const name = patch.name ?? found.name;
  // Before settings: read by the session screen (lib/context-upload), enforced by session start and the attach
  // route. An older `twinSettings` key is left as is; `before` wins.
  const data = {
    ...previous,
    name,
    objective: patch.description ?? previous.objective,
    before: { ...beforeSettings(current.data), ...patch.settings },
  };
  if (JSON.stringify(data) === JSON.stringify(current.data) && name === found.name) return { version: current.version, changed: false };
  await db.$transaction([
    db.specVersion.create({ data: { entityType: "agents", entitySlug: found.slug, version: current.version, data: json(current.data), orgId } }),
    db.agent.update({ where: { id: found.id }, data: { name, version: current.version + 1, data: json(data) } }),
  ]);
  return { version: current.version + 1, changed: true };
}
