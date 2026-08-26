"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import yaml from "js-yaml";
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Download,
  History,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { seedCopilot } from "@/lib/copilot-handoff";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

type ResourceType = "personas" | "agents";
type Summary = { slug: string; name: string; version: number; domainSlug?: string; status?: "draft" | "published" };
type VersionInfo = { version: number; createdAt: string; label: string };

const COPY = {
  personas: {
    single: "persona",
    title: "Personas",
    description: "Reusable trainer behavior, communication style, and decision preferences.",
  },
  agents: {
    single: "agent",
    title: "Agents",
    description: "Draft and published interview structures, evidence strategies, and progression policies.",
  },
} as const;

export function SpecResourceIndex({ type, specs }: { type: ResourceType; specs: Summary[] }) {
  const router = useRouter();
  const copy = COPY[type];
  const Icon = type === "personas" ? UserRound : Bot;

  async function createNew() {
    const slug = prompt(`New ${copy.single} id (for example, my-${copy.single}):`);
    if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return;
    const key = type === "personas" ? "persona" : "agent";
    let domainLine = "";
    if (type === "agents") {
      const response = await fetch("/api/spec/domains");
      const domains = ((await response.json()).specs ?? []) as string[];
      if (!domains.length) return toast.error("Create a domain before creating an agent");
      const domain = prompt(`Domain id (${domains.join(", ")}):`, domains[0]);
      if (!domain) return;
      domainLine = `  domain: ${domain}\n`;
    }
    const text = `schema_version: 1\nkind: ${key}\n\n${key}:\n  id: ${slug}\n  name: ${copy.single} ${slug}\n  version: 1\n${domainLine}`;
    const response = await fetch(`/api/spec/${type}/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const result = await response.json();
    if (!response.ok) return toast.error(result.error ?? `Could not create ${copy.single}`);
    toast.success(`Created ${slug}`);
    router.push(`/${type}/${encodeURIComponent(slug)}`);
  }

  async function designWithCopilot() {
    if (type !== "agents") return;
    const goal = prompt("What should this agent train? Describe the learner and the desired outcome:");
    if (!goal?.trim()) return;
    seedCopilot(
      `I want to design a new trainer agent from scratch. Here is what I want it to accomplish: ${goal.trim()}\n\nFollow the spec-builder method and walk me through it.`,
    );
    router.push("/");
  }

  function publishDraft(slug: string) {
    seedCopilot(`Publish the working draft "${slug}". Read and validate it first, then call publish_spec_draft so I can review and approve the publication.`);
    router.push("/");
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{copy.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {type === "agents" && (
              <Button variant="outline" onClick={designWithCopilot}>
                <Sparkles data-icon="inline-start" /> Design with Copilot
              </Button>
            )}
            <Button onClick={createNew}>
              <Plus data-icon="inline-start" /> New {copy.single}
            </Button>
          </div>
        </header>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {specs.map((spec) => (
            <article
              key={spec.slug}
              className="group min-w-0 overflow-hidden rounded-xl border bg-background transition-colors hover:border-foreground/20 hover:bg-muted/40"
            >
              <Link
                href={`/${type}/${encodeURIComponent(spec.slug)}`}
                className="flex min-h-40 min-w-0 flex-col p-5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
              >
                <span className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <Badge variant={spec.status === "draft" ? "outline" : "secondary"} className="ml-auto">
                    {spec.status === "draft" ? `Draft · r${spec.version}` : `v${spec.version}`}
                  </Badge>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
                <span className="mt-5 block truncate text-base font-medium">{spec.name}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{spec.slug}</span>
                <span className="mt-auto block truncate pt-4 text-xs text-muted-foreground">
                  {spec.domainSlug ? `Domain · ${spec.domainSlug}` : "Reusable behavior profile"}
                </span>
              </Link>
              {type === "agents" && spec.status === "draft" && (
                <div className="flex justify-end border-t px-3 py-2.5">
                  <Button size="sm" onClick={() => publishDraft(spec.slug)}>
                    <Sparkles data-icon="inline-start" /> Publish
                  </Button>
                </div>
              )}
            </article>
          ))}
          {!specs.length && (
            <div className="rounded-xl border px-5 py-16 text-center md:col-span-2">
              <p className="text-sm font-medium">No {type} yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Create the first {copy.single} to get started.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export function SpecDraftResourceViewer({
  slug,
  name,
  text,
  revision,
}: {
  slug: string;
  name: string;
  text: string;
  revision: number;
}) {
  const router = useRouter();

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon-sm" render={<Link href="/agents" />} nativeButton={false} aria-label="Back to agents">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{name}</h1>
            <Badge variant="outline">Draft · r{revision}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{slug}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<a href={`/api/spec-drafts/${encodeURIComponent(slug)}/agent`} />}
          >
            <Download data-icon="inline-start" /> Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              seedCopilot(`Continue the working draft "${slug}". Read it with read_spec_draft before proposing the next change.`);
              router.push("/");
            }}
          >
            <Sparkles data-icon="inline-start" /> Continue in Copilot
          </Button>
          <Button
            size="sm"
            onClick={() => {
              seedCopilot(`Publish the working draft "${slug}". Read and validate it first, then call publish_spec_draft so I can review and approve the publication.`);
              router.push("/");
            }}
          >
            <Sparkles data-icon="inline-start" /> Publish
          </Button>
        </div>
      </header>

      <div className="shrink-0 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-6">
        This agent is a working draft. It will become runnable only after validation and publication approval.
      </div>

      <div className="min-h-0 flex-1 p-4 sm:p-6">
        <textarea
          value={text}
          readOnly
          spellCheck={false}
          aria-label={`${name} draft YAML specification`}
          className="h-full min-h-80 w-full resize-none rounded-xl border bg-muted/20 p-4 font-mono text-xs leading-relaxed outline-none"
        />
      </div>
    </main>
  );
}

export function SpecResourceEditor({
  type,
  slug,
  name,
  text: initialText,
  currentVersion,
  shownVersion,
  versions,
}: {
  type: ResourceType;
  slug: string;
  name: string;
  text: string;
  currentVersion: number;
  shownVersion: number;
  versions: VersionInfo[];
}) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const historical = shownVersion !== currentVersion;
  const basePath = `/${type}/${encodeURIComponent(slug)}`;
  const copy = COPY[type];

  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (type !== "agents") return;
    fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((d) => setVoices(d.voices ?? []))
      .catch(() => setVoices([]));
  }, [type]);

  let currentVoiceId = "";
  if (type === "agents") {
    try {
      const agent = (yaml.load(text) as Record<string, Record<string, unknown>> | null)?.agent;
      if (typeof agent?.voiceId === "string") currentVoiceId = agent.voiceId;
    } catch {
      // invalid YAML mid-edit; picker just shows empty
    }
  }

  function setVoice(voiceId: string) {
    try {
      const doc = yaml.load(text) as Record<string, Record<string, unknown>> | null;
      if (!doc?.agent || typeof doc.agent !== "object") return;
      if (voiceId) doc.agent.voiceId = voiceId;
      else delete doc.agent.voiceId;
      setText(yaml.dump(doc, { lineWidth: -1 }));
      setDirty(true);
    } catch {
      toast.error("Fix the YAML first, then pick a voice");
    }
  }

  async function save(value = text) {
    if (saving) return;
    setSaving(true);
    const response = await fetch(`/api/spec/${type}/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: value }),
    });
    const result = await response.json();
    setSaving(false);
    if (!response.ok) return toast.error(result.error ?? "Save failed");
    setDirty(false);
    toast.success(result.versionBumped ? `Saved as v${result.version}` : "No changes to save");
    router.replace(basePath);
    router.refresh();
  }

  async function remove() {
    if (!confirm(`Delete ${slug}? Its version history will also be removed.`)) return;
    const response = await fetch(`/api/spec/${type}/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!response.ok) return toast.error(`Could not delete ${slug}`);
    toast.success(`Deleted ${slug}`);
    router.push(`/${type}`);
    router.refresh();
  }

  async function restore() {
    if (!confirm(`Restore v${shownVersion} as the current ${copy.single}? The current version will remain in history.`)) return;
    await save(initialText);
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon-sm" render={<Link href={`/${type}`} />} nativeButton={false} aria-label={`Back to ${type}`}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{name}</h1>
            <Badge variant={historical ? "outline" : "secondary"}>{historical ? `History v${shownVersion}` : `Current v${currentVersion}`}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{slug}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {type === "agents" && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Refine this agent with the spec copilot"
              onClick={() => {
                seedCopilot(
                  `Please load my published agent "${slug}" (its current version) with read_spec, then start a working draft so we can revise it together.`,
                );
                router.push("/");
              }}
            >
              <Sparkles data-icon="inline-start" /> Refine with Copilot
            </Button>
          )}
          <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <History data-icon="inline-start" /> History
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Versions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push(basePath)}>
                <History /> Current · v{currentVersion}
              </DropdownMenuItem>
              {versions.map((version) => (
                <DropdownMenuItem key={version.version} onClick={() => router.push(`${basePath}?version=${version.version}`)}>
                  <RotateCcw /> {version.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {historical ? (
          <Button size="sm" onClick={restore} disabled={saving}>
            {saving ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
            Restore v{shownVersion}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={remove}>
              <Trash2 data-icon="inline-start" /> Delete
            </Button>
            <Button size="sm" onClick={() => save()} disabled={!dirty || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              Save
            </Button>
          </>
        )}
        </div>
      </header>

      {historical && (
        <div className="shrink-0 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-6">
          Viewing immutable version {shownVersion}. Restore it to create a new current version.
        </div>
      )}

      <div className="min-h-0 flex-1 p-4 sm:p-6">
        {type === "agents" && !historical && (
          <div className="mb-3 flex items-center gap-3">
            <span className="shrink-0 text-sm font-medium">Voice</span>
            <Select value={currentVoiceId || "none"} onValueChange={(v) => v !== null && setVoice(v === "none" ? "" : v)}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="No voices yet" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Trainer voices</SelectLabel>
                  <SelectItem value="none">None</SelectItem>
                  {voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Link href="/voice" className="text-xs text-muted-foreground hover:underline">
              Manage voices
            </Link>
          </div>
        )}
        <textarea
          value={text}
          readOnly={historical}
          onChange={(event) => { setText(event.target.value); setDirty(true); }}
          spellCheck={false}
          aria-label={`${name} YAML specification`}
          className="h-full min-h-80 w-full resize-none rounded-xl border bg-background p-4 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted"
        />
      </div>
    </main>
  );
}
