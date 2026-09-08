"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import yaml from "js-yaml";
import {
  ArrowLeft,
  History,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { MessagesSquareIcon } from "@/components/icons/messages-square-icon";
import { UserRoundIcon } from "@/components/icons/user-round-icon";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { seedCopilot } from "@/lib/copilot-handoff";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PersonaSourcePanel } from "@/components/persona-source-panel";

type ResourceType = "personas" | "agents";
type Summary = {
  slug: string;
  name: string;
  version: number;
  objective?: string;
  status?: "draft" | "published";
  draftRevision?: number;
};
type VersionInfo = { version: number; createdAt: string; label: string };

const COPY = {
  personas: {
    single: "persona",
    title: "Personas",
    description: "Reusable behavior, communication style, and decision preferences.",
  },
  agents: {
    single: "scenario",
    title: "Scenarios",
    description: "Bounded experiences that bring personas, voices, knowledge, and progression rules together.",
  },
} as const;

type VoiceOption = { id: string; name: string; status: string };
type KnowledgeOption = { slug: string; name: string };
type AgentField = "name" | "voiceId" | "knowledgeBase";

function readAgentSettings(text: string, fallbackName: string) {
  try {
    const agent = (yaml.load(text) as Record<string, Record<string, unknown>> | null)?.agent;
    return {
      name: typeof agent?.name === "string" ? agent.name : fallbackName,
      voiceId: typeof agent?.voiceId === "string" ? agent.voiceId : "",
      knowledgeBase: typeof agent?.knowledgeBase === "string" ? agent.knowledgeBase : "",
    };
  } catch {
    return { name: fallbackName, voiceId: "", knowledgeBase: "" };
  }
}

function updateAgentText(text: string, field: AgentField, value: string) {
  try {
    const doc = yaml.load(text) as Record<string, Record<string, unknown>> | null;
    if (!doc?.agent || typeof doc.agent !== "object") return null;
    if ((field === "voiceId" || field === "knowledgeBase") && !value) delete doc.agent[field];
    else doc.agent[field] = value;
    return yaml.dump(doc, { lineWidth: -1 });
  } catch {
    return null;
  }
}

function AgentSettingsPanel({
  name,
  voiceId,
  voices,
  knowledgeBase,
  knowledgeBases,
  disabled,
  onChange,
}: {
  name: string;
  voiceId: string;
  voices: VoiceOption[];
  knowledgeBase: string;
  knowledgeBases: KnowledgeOption[];
  disabled?: boolean;
  onChange: (field: AgentField, value: string) => void;
}) {
  return (
    <aside className="bg-muted/20 border-t p-4 sm:p-6 lg:overflow-y-auto lg:border-t-0 lg:border-l">
      <h2 className="text-sm font-semibold">Scenario settings</h2>
      <p className="text-muted-foreground mt-1 text-xs leading-5">
        Configure how this scenario appears and speaks.
      </p>
      <FieldGroup className="mt-6">
        <Field data-invalid={!name.trim()}>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input
            id="agent-name"
            value={name}
            disabled={disabled}
            aria-invalid={!name.trim()}
            required
            onChange={(event) => onChange("name", event.target.value)}
          />
          <FieldDescription>Shown wherever this scenario is available.</FieldDescription>
          {!name.trim() ? <FieldError>Enter a scenario name.</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel>Knowledge base</FieldLabel>
          <Select
            value={knowledgeBase || "none"}
            disabled={disabled}
            onValueChange={(value) =>
              value !== null && onChange("knowledgeBase", value === "none" ? "" : value)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a knowledge base" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Workspace knowledge</SelectLabel>
                <SelectItem value="none">No attached knowledge</SelectItem>
                {knowledgeBases.map((base) => (
                  <SelectItem key={base.slug} value={base.slug}>
                    {base.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            Only this collection is searched while the scenario runs. <Link href="/knowledge">Manage knowledge</Link>.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Voice</FieldLabel>
          <Select
            value={voiceId || "none"}
            disabled={disabled}
            onValueChange={(value) =>
              value !== null && onChange("voiceId", value === "none" ? "" : value)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a voice" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Available voices</SelectLabel>
                <SelectItem value="none">No assigned voice</SelectItem>
                {voices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    {voice.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            Used whenever this scenario speaks. <Link href="/voice">Manage voices</Link>.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </aside>
  );
}

function SpecCard({
  type,
  spec,
}: {
  type: ResourceType;
  spec: Summary;
}) {
  const iconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null);
  const objective =
    spec.objective ||
    (type === "agents"
      ? "A guided conversational scenario."
      : "A reusable behavioral persona.");

  return (
    <Link
      href={`/${type}/${encodeURIComponent(spec.slug)}`}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <Card className="flex h-full min-h-48 flex-col transition-colors group-hover:border-foreground/20 group-hover:bg-accent/40">
        <CardHeader>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
              {type === "personas" ? (
                <UserRoundIcon ref={iconRef} size={20} />
              ) : (
                <MessagesSquareIcon ref={iconRef} size={20} />
              )}
            </span>
            {type === "agents" && (spec.status === "draft" ? (
              <Badge variant="outline">Draft r{spec.version}</Badge>
            ) : spec.draftRevision ? (
              <Badge variant="outline">Draft r{spec.draftRevision}</Badge>
            ) : (
              <Badge variant="secondary">Published</Badge>
            ))}
          </div>
          <CardTitle className="text-base font-semibold group-hover:text-primary transition-colors">
            {spec.name}
          </CardTitle>
          <CardDescription className="line-clamp-3 leading-5 text-xs sm:text-sm">
            {objective}
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-auto">
          <p className="truncate text-xs text-muted-foreground">
            {type === "agents"
              ? spec.status === "draft"
                ? `Draft revision ${spec.version}`
                : `Published version ${spec.version}`
              : `Version ${spec.version}`}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

export function SpecResourceIndex({ type, specs }: { type: ResourceType; specs: Summary[] }) {
  const router = useRouter();
  const copy = COPY[type];
  const [createOpen, setCreateOpen] = useState(false);
  const [newScenarioName, setNewScenarioName] = useState("");
  const [creating, setCreating] = useState(false);

  async function createNew(agentName?: string) {
    if (type === "agents") {
      // Instruction-first: create routes to the editor; domain and specs are
      // generated on the first save.
      const name = agentName?.trim();
      if (!name) return;
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      if (!base || !/^[a-z0-9][a-z0-9._-]*$/i.test(base)) return toast.error("Could not derive a valid id from that name");
      let slug = base;
      for (let n = 2; ; n++) {
        const [spec, draft] = await Promise.all([
          fetch(`/api/spec/agents/${encodeURIComponent(slug)}`),
          fetch(`/api/spec-drafts/${encodeURIComponent(slug)}/agent`),
        ]);
        if ([spec, draft].some((response) => !response.ok && response.status !== 404)) {
          throw new Error("Could not check scenario availability");
        }
        if (!spec.ok && !draft.ok) break;
        slug = `${base}-${n}`;
      }
      setCreateOpen(false);
      router.push(`/agents/${encodeURIComponent(slug)}/edit?new=1`);
      return;
    }
    const slug = prompt(`New ${copy.single} id (for example, my-${copy.single}):`);
    if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return;
    const key = type === "personas" ? "persona" : "agent";
    const text = `schema_version: 1\nkind: ${key}\n\n${key}:\n  id: ${slug}\n  name: ${slug}\n  version: 1\n`;
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

  async function submitNewScenario() {
    if (!newScenarioName.trim() || creating) return;
    setCreating(true);
    try {
      await createNew(newScenarioName);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create scenario");
    } finally {
      setCreating(false);
    }
  }

  async function designWithCopilot() {
    if (type !== "agents") return;
    seedCopilot("I want to design a new scenario from scratch. Follow the spec-builder method and walk me through it.");
    router.push("/");
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow">
        <PageHeader
          className="border-b pb-6"
          title={copy.title}
          description={copy.description}
          actions={
            <>
              {type === "agents" && (
                <Button variant="outline" onClick={designWithCopilot}>
                  <Sparkles data-icon="inline-start" /> Design with Copilot
                </Button>
              )}
              <Button onClick={() => type === "agents" ? setCreateOpen(true) : void createNew()}>
                <Plus data-icon="inline-start" /> New {copy.single}
              </Button>
            </>
          }
        />

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {specs.map((spec) => (
            <SpecCard key={spec.slug} type={type} spec={spec} />
          ))}
          {!specs.length && (
            <div className="rounded-xl border px-5 py-16 text-center md:col-span-2 xl:col-span-3">
              <p className="text-sm font-medium">No {copy.title.toLowerCase()} yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Create the first {copy.single} to get started.</p>
            </div>
          )}
        </div>

        {type === "agents" && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create scenario</DialogTitle>
                <DialogDescription>
                  Start with a name. You will describe the scenario on the next screen.
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitNewScenario();
                }}
              >
                <Field>
                  <FieldLabel htmlFor="new-scenario-name">Name</FieldLabel>
                  <Input
                    id="new-scenario-name"
                    value={newScenarioName}
                    maxLength={120}
                    autoFocus
                    onChange={(event) => setNewScenarioName(event.target.value)}
                    placeholder="React mock interview"
                  />
                </Field>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={creating} />}>Cancel</DialogClose>
                  <Button type="submit" disabled={!newScenarioName.trim() || creating}>
                    {creating ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                    Continue
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </PageContainer>
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
  sources = [],
}: {
  type: ResourceType;
  slug: string;
  name: string;
  text: string;
  currentVersion: number;
  shownVersion: number;
  versions: VersionInfo[];
  sources?: { id: string; kind: string; name: string; status: string; metadata?: unknown; createdAt: Date }[];
}) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const historical = shownVersion !== currentVersion;
  const basePath = `/${type}/${encodeURIComponent(slug)}`;
  const editPath = type === "agents" ? `${basePath}/edit` : basePath;
  const copy = COPY[type];

  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeOption[]>([]);
  useEffect(() => {
    if (type !== "agents") return;
    fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((d) => setVoices((d.voices ?? []).filter((voice: { status?: string }) => voice.status === "ready")))
      .catch(() => setVoices([]));
    fetch("/api/knowledge")
      .then((response) => response.json())
      .then((data) => setKnowledgeBases(data.knowledgeBases ?? []))
      .catch(() => setKnowledgeBases([]));
  }, [type]);

  const settings = readAgentSettings(text, name);

  function setAgentField(field: AgentField, value: string) {
    const next = updateAgentText(text, field, value);
    if (!next) return toast.error("Fix the YAML before changing scenario settings");
    setText(next);
    setDirty(true);
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
    router.replace(editPath);
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
        <Button variant="ghost" size="icon-sm" render={<Link href={type === "agents" ? basePath : `/${type}`} />} nativeButton={false} aria-label={`Back to ${type === "agents" ? "preview" : copy.title}`}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">
              {type === "agents" ? settings.name || name : name}
            </h1>
            <Badge variant={historical ? "outline" : "secondary"}>{historical ? `History v${shownVersion}` : `Current v${currentVersion}`}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{slug}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {type === "agents" && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Refine this scenario with Copilot"
              onClick={() => {
                seedCopilot(
                  `Please load my published scenario "${slug}" (its current version) with read_spec, then start a working draft so we can revise it together.`,
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
              <DropdownMenuItem onClick={() => router.push(editPath)}>
                <History /> Current · v{currentVersion}
              </DropdownMenuItem>
              {versions.map((version) => (
                <DropdownMenuItem key={version.version} onClick={() => router.push(`${editPath}?version=${version.version}`)}>
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
            {(type === "agents" || dirty) && (
              <Button
                size="sm"
                onClick={() => save()}
                disabled={!dirty || saving || (type === "agents" && !settings.name.trim())}
              >
                {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                Save
              </Button>
            )}
          </>
        )}
        </div>
      </header>

      {historical && (
        <div className="shrink-0 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-6">
          Viewing immutable version {shownVersion}. Restore it to create a new current version.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)] lg:overflow-hidden">
        <section className={type === "agents"
          ? "flex min-h-[32rem] min-w-0 flex-col p-4 sm:p-6 lg:min-h-0 lg:overflow-hidden"
          : "order-2 min-w-0 border-t bg-muted/20 p-4 sm:p-6 lg:overflow-y-auto lg:border-t-0 lg:border-l"
        }>
          {type === "agents" ? (
            <>
              <div className="mb-3 shrink-0">
                <h2 className="text-sm font-medium">Scenario definition</h2>
                <p className="mt-1 text-xs text-muted-foreground">Advanced behavior, stages, and progression policy.</p>
              </div>
              <textarea
                value={text}
                readOnly={historical}
                onChange={(event) => { setText(event.target.value); setDirty(true); }}
                spellCheck={false}
                aria-label={`${name} YAML specification`}
                className="min-h-80 w-full flex-1 resize-none rounded-xl border bg-background p-4 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted"
              />
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold">Persona model</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Automatically rebuilt after every source in the library finishes indexing.
              </p>
              <div className="mt-5 rounded-xl border bg-background p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="size-4 text-primary" /> Automatic
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Sources shape the speaking style. The compiled policy keeps behavior stable and versioned.
                </p>
              </div>
              <details className="mt-4 rounded-xl border bg-background">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
                  Advanced YAML
                </summary>
                <div className="border-t p-3">
                  <textarea
                    value={text}
                    readOnly={historical}
                    onChange={(event) => { setText(event.target.value); setDirty(true); }}
                    spellCheck={false}
                    aria-label={`${name} YAML specification`}
                    className="min-h-96 w-full resize-y rounded-lg border bg-background p-3 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted"
                  />
                </div>
              </details>
            </>
          )}
        </section>

        {type === "agents" ? (
          <AgentSettingsPanel
            name={settings.name}
            voiceId={settings.voiceId}
            voices={voices}
            knowledgeBase={settings.knowledgeBase}
            knowledgeBases={knowledgeBases}
            disabled={historical}
            onChange={setAgentField}
          />
        ) : (
          <PersonaSourcePanel
            personaSlug={slug}
            initialSources={sources}
            disabled={historical}
          />
        )}
      </div>
    </main>
  );
}
