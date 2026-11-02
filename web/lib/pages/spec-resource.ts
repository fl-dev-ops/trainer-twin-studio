import { TRPCError } from "@trpc/server";
import yaml from "js-yaml";
import type { ComponentProps } from "react";
import type { AgentEditor } from "@/components/agent-editor";
import type { SpecResourceEditor } from "@/components/spec-resource";
import { db } from "@/lib/db";
import { DEFAULT_RESUME_INTERVIEW_CONFIG, interviewConfigSchema, type InterviewConfig } from "@/lib/interview-config-schema";
import { getPersonaBaseline } from "@/lib/persona-baseline";
import { readSpecDraft } from "@/lib/spec-drafts";
import { listSpecs, listVersions, readSpec, readVersion } from "@/lib/specs";

/** What /agents/<slug>/edit and a persona's spec page render: the agent editor or the YAML spec editor, with its key. */
export type SpecResourceView =
  | { view: "agent"; key: string; props: ComponentProps<typeof AgentEditor> }
  | { view: "spec"; key: string; props: ComponentProps<typeof SpecResourceEditor> };

const notFound = (): never => {
  throw new TRPCError({ code: "NOT_FOUND" });
};

function interviewConfigOf(agent: Record<string, unknown>): InterviewConfig {
  const config = agent.config && typeof agent.config === "object" ? agent.config as Record<string, unknown> : {};
  const configured = interviewConfigSchema.safeParse(config.interview);
  return configured.success ? configured.data : DEFAULT_RESUME_INTERVIEW_CONFIG;
}

function contextPromptOf(agent: Record<string, unknown>): string {
  const config = agent.config && typeof agent.config === "object" ? agent.config as Record<string, unknown> : {};
  const ctx = config.context && typeof config.context === "object" ? config.context as Record<string, unknown> : {};
  return typeof ctx.prompt === "string" ? ctx.prompt : "";
}

function contextFieldOf(agent: Record<string, unknown>, field: string): string {
  const config = agent.config && typeof agent.config === "object" ? agent.config as Record<string, unknown> : {};
  const ctx = config.context && typeof config.context === "object" ? config.context as Record<string, unknown> : {};
  return typeof ctx[field] === "string" ? (ctx[field] as string) : "";
}

function contextMaxFilesOf(agent: Record<string, unknown>): number {
  const config = agent.config && typeof agent.config === "object" ? agent.config as Record<string, unknown> : {};
  const ctx = config.context && typeof config.context === "object" ? config.context as Record<string, unknown> : {};
  return typeof ctx.max_files === "number" && ctx.max_files >= 1 ? Math.min(ctx.max_files, 5) : 1;
}

export async function loadSpecResource({
  orgId,
  type,
  slug,
  requestedVersion,
  isNew = false,
}: {
  orgId: string;
  type: "personas" | "agents";
  slug: string;
  requestedVersion?: string;
  isNew?: boolean;
}): Promise<SpecResourceView> {
  const current = await readSpec(type, slug, orgId).catch(() => null);

  if (type === "agents") {
    const version = requestedVersion === undefined ? undefined : Number(requestedVersion);
    if (requestedVersion !== undefined && (!Number.isInteger(version) || (version as number) < 1)) notFound();
    const historical =
      current && version !== undefined && version !== current.version
        ? await readVersion(type, slug, version as number, orgId)
        : null;
    if (requestedVersion !== undefined && !current && !historical) notFound();
    if (requestedVersion !== undefined && current && version !== current.version && !historical) notFound();

    const [personas, versions, topics] = await Promise.all([
      listSpecs("personas", orgId).then((slugs) =>
        db.persona.findMany({ where: { orgId, slug: { in: slugs.length ? slugs : ["__none__"] } }, orderBy: { slug: "asc" }, select: { slug: true, name: true } }),
      ),
      current ? listVersions(type, slug, orgId) : Promise.resolve([]),
      db.topic.findMany({ where: { status: "approved" }, orderBy: { slug: "asc" }, select: { slug: true, description: true } }),
    ]);

    if (!current) {
      if (requestedVersion !== undefined) notFound();
      const draft = isNew ? null : await readSpecDraft(slug, orgId).catch(() => null);
      if (!draft && !isNew) notFound();
      const agent = (draft?.agent ?? {}) as Record<string, unknown>;
      return {
        view: "agent",
        key: `draft:${slug}:${draft?.revision ?? 0}`,
        props: {
          slug,
          instruction: typeof agent.instruction === "string" ? agent.instruction : "",
          name: draft?.name ?? "",
          opening: typeof agent.opening === "string" ? agent.opening : "",
          personaSlug: draft?.personaSlug ?? "",
          knowledgeBase: typeof agent.knowledgeBase === "string" ? agent.knowledgeBase : "",
          voiceId: typeof agent.voiceId === "string" ? agent.voiceId : "",
          specYaml: "",
          revision: draft?.revision,
          versions: [],
          personas,
          topics,
          interviewConfig: interviewConfigOf(agent),
          contextPrompt: contextPromptOf(agent),
          contextLabel: contextFieldOf(agent, "label"),
          contextMaxFiles: contextMaxFilesOf(agent),
        },
      };
    }

    if (historical) {
      return {
        view: "spec",
        key: `${slug}:${current.version}:${version}`,
        props: {
          type,
          slug,
          name: typeof current.doc.name === "string" ? current.doc.name : slug,
          text: historical.text,
          currentVersion: current.version,
          shownVersion: version as number,
          versions,
        },
      };
    }

    const doc = current.doc as Record<string, unknown>;
    const draft = await readSpecDraft(slug, orgId).catch(() => null);
    const working = (draft?.agent ?? doc) as Record<string, unknown>;
    return {
      view: "agent",
      key: `current:${slug}:${current.version}:${draft?.revision ?? 0}`,
      props: {
        slug,
        instruction: typeof working.instruction === "string" ? working.instruction : "",
        name: typeof working.name === "string" ? working.name : slug,
        opening: typeof working.opening === "string" ? working.opening : "",
        personaSlug: draft?.personaSlug ?? personas[0]?.slug ?? "",
        knowledgeBase: typeof working.knowledgeBase === "string" ? working.knowledgeBase : "",
        voiceId: typeof working.voiceId === "string" ? working.voiceId : "",
        specYaml: yaml.dump({ schema_version: 1, kind: "agent", agent: working }, { lineWidth: -1, noRefs: true }),
        revision: draft?.status === "draft" ? draft.revision : undefined,
        publishedVersion: current.version,
        versions,
        personas,
        topics,
        interviewConfig: interviewConfigOf(working),
        contextPrompt: contextPromptOf(working),
        contextLabel: contextFieldOf(working, "label"),
        contextMaxFiles: contextMaxFilesOf(working),
      },
    };
  }

  // Personas keep the YAML editor.
  if (!current) return notFound();
  const version = requestedVersion === undefined ? current.version : Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1) notFound();
  const historical = version === current.version ? current : await readVersion(type, slug, version, orgId);
  if (!historical) return notFound();

  const persona = await db.persona.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { id: true } });
  if (!persona) return notFound();
  const [initialSources, baseline, versions] = await Promise.all([
    db.personaSource.findMany({
      where: { personaId: persona.id, orgId },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, name: true, status: true, metadata: true, createdAt: true },
    }),
    getPersonaBaseline(orgId, slug),
    listVersions(type, slug, orgId),
  ]);

  return {
    view: "spec",
    key: `${slug}:${current.version}:${version}`,
    props: {
      type,
      slug,
      name: typeof current.doc.name === "string" ? current.doc.name : slug,
      text: historical.text,
      currentVersion: current.version,
      shownVersion: version,
      versions,
      sources: initialSources,
      baseline,
    },
  };
}
