"use client";

import { useSearchParams } from "next/navigation";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { MarkdownPlugin } from "@platejs/markdown";
import { Editor, EditorContainer } from "@/components/ui/editor";
import yaml from "js-yaml";
import { ArrowLeft, History, RotateCcw, Save, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QUESTION_TYPES, type QuestionType } from "@shared/interview-question-types";
import {
  DEFAULT_TECHNICAL_QUESTION_COUNTS,
  interviewConfigSchema,
  type InterviewConfig,
} from "@/lib/interview-config-schema";

const GENERIC_SAVE_ERROR =
  "Failed to save the change, try again in a few seconds";

type VoiceOption = { id: string; name: string; status: string };
type KnowledgeOption = { slug: string; name: string; topicSlugs?: string[] };
type PersonaOption = { slug: string; name: string };
type TopicOption = { slug: string; description: string };
type VersionInfo = { version: number; createdAt: string; label: string };

export type AgentEditorProps = {
  slug: string;
  instruction: string;
  name: string;
  opening: string;
  personaSlug: string;
  knowledgeBase: string;
  voiceId: string;
  specYaml: string;
  revision?: number;
  publishedVersion?: number;
  versions: VersionInfo[];
  personas: PersonaOption[];
  topics: TopicOption[];
  interviewConfig: InterviewConfig;
};

export function AgentEditor(initial: AgentEditorProps) {
  const router = useRouter();
  const [instruction, setInstruction] = useState(initial.instruction);
  const [name, setName] = useState(initial.name);
  const [opening, setOpening] = useState(initial.opening);
  const [personaSlug, setPersonaSlug] = useState(initial.personaSlug);
  const [knowledgeBase, setKnowledgeBase] = useState(initial.knowledgeBase);
  const [interviewConfig, setInterviewConfig] = useState<InterviewConfig>(initial.interviewConfig);
  const [voiceId, setVoiceId] = useState(initial.voiceId);
  const [specYaml, setSpecYaml] = useState(initial.specYaml);
  const [revision, setRevision] = useState(initial.revision);
  const [publishedVersion, setPublishedVersion] = useState(
    initial.publishedVersion,
  );
  const [versions, setVersions] = useState(initial.versions);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const showSpec = useSearchParams().get("debug") === "true";
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeOption[]>([]);
  const availableTopicSlugs = new Set(
    knowledgeBases.find((base) => base.slug === knowledgeBase)?.topicSlugs ?? [],
  );
  const availableTopics = initial.topics.filter((topic) => availableTopicSlugs.has(topic.slug));

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((d) =>
        setVoices(
          (d.voices ?? []).filter(
            (voice: VoiceOption) => voice.status === "ready",
          ),
        ),
      )
      .catch(() => setVoices([]));
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((d) => setKnowledgeBases(d.knowledgeBases ?? []))
      .catch(() => setKnowledgeBases([]));
  }, []);

  const ready = instruction.trim() && name.trim() && opening.trim() && personaSlug &&
    interviewConfigSchema.safeParse(interviewConfig).success &&
    (interviewConfig.type !== "technical" || Boolean(knowledgeBase));

  async function generate(publish: boolean) {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(initial.slug)}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: instruction.trim(),
            name: name.trim(),
            opening: opening.trim(),
            personaSlug,
            knowledgeBase: knowledgeBase || undefined,
            voiceId: voiceId || undefined,
            publish,
            interviewConfig,
          }),
        },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? GENERIC_SAVE_ERROR);
      if (result.agent && result.domain) {
        setSpecYaml(
          yaml.dump(
            {
              schema_version: 1,
              kind: "agent",
              agent: result.agent,
              domain: result.domain,
            },
            { lineWidth: -1, noRefs: true },
          ),
        );
      }
      if (publish) {
        setPublishedVersion(result.agentVersion ?? publishedVersion);
        setRevision(undefined);
        setDirty(false);
        toast.success(`Published v${result.agentVersion ?? ""}`.trim());
      } else {
        setRevision(result.revision ?? revision);
        setDirty(false);
        toast.success(`Saved as draft r${result.revision ?? ""}`.trim());
      }
      router.refresh();
      // Refresh the version list after regeneration.
      fetch(`/api/spec/agents/${encodeURIComponent(initial.slug)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => data?.versions && setVersions(data.versions))
        .catch(() => {});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : GENERIC_SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3 sm:flex-nowrap sm:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href={publishedVersion || revision ? `/agents/${encodeURIComponent(initial.slug)}` : "/agents"} />}
          nativeButton={false}
          aria-label="Back to scenarios"
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">
              {name || initial.slug}
            </h1>
            <Badge variant={publishedVersion ? "secondary" : "outline"}>
              {publishedVersion
                ? `Published v${publishedVersion}`
                : "New scenario"}
              {revision ? ` · draft r${revision}` : ""}
            </Badge>
            {dirty && <Badge variant="outline">Unsaved</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {initial.slug}
          </p>
        </div>
        <div className="order-last flex w-full flex-wrap items-center justify-end gap-2 sm:order-none sm:w-auto sm:shrink-0">
          {versions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" />}
              >
                <History data-icon="inline-start" /> History
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Versions</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {publishedVersion && (
                    <DropdownMenuItem onClick={() => router.push(`/agents/${encodeURIComponent(initial.slug)}/edit`)}>
                      <History /> Current · v{publishedVersion}
                    </DropdownMenuItem>
                  )}
                  {versions.map((version) => (
                    <DropdownMenuItem
                      key={version.version}
                      onClick={() =>
                        router.push(
                          `/agents/${encodeURIComponent(initial.slug)}/edit?version=${version.version}`,
                        )
                      }
                    >
                      <RotateCcw /> {version.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => generate(false)}
            disabled={!ready || busy}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            Save draft
          </Button>
          <Button
            size="sm"
            onClick={() => generate(true)}
            disabled={!ready || busy}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            Publish
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)] lg:overflow-hidden">
        <section className="flex min-h-128 min-w-0 flex-col gap-5 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto">
          <Field data-invalid={dirty && !instruction.trim()}>
            <FieldLabel htmlFor="agent-instruction">Instructions</FieldLabel>
            <InstructionEditor
              value={instruction}
              onMarkdownChange={(markdown) => {
                setInstruction(markdown);
                setDirty(true);
              }}
            />
            {dirty && !instruction.trim() ? (
              <FieldError>Describe the scenario before saving.</FieldError>
            ) : null}
          </Field>

          <Field data-invalid={dirty && !opening.trim()}>
            <FieldLabel htmlFor="agent-opening">First message</FieldLabel>
            <textarea
              id="agent-opening"
              value={opening}
              onChange={(event) => {
                setOpening(event.target.value);
                setDirty(true);
              }}
              placeholder="What the agent says when the session starts"
              rows={5}
              aria-label="First message"
              className="w-full resize-y rounded-xl border bg-background px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {dirty && !opening.trim() ? (
              <FieldError>Add a first message.</FieldError>
            ) : null}
          </Field>

          {specYaml && showSpec && (
            <details className="rounded-xl border bg-muted/20">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
                Compiled specs
              </summary>
              <pre className="overflow-x-auto px-4 pb-4 font-mono text-xs leading-relaxed whitespace-pre text-muted-foreground">
                {specYaml}
              </pre>
            </details>
          )}
        </section>

        <aside className="bg-muted/20 border-t p-4 sm:p-6 lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <h2 className="text-sm font-semibold">Scenario settings</h2>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            Applied when you save or publish.
          </p>
          <FieldGroup className="mt-6">
            <Field data-invalid={!name.trim()}>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input
                id="agent-name"
                value={name}
                aria-invalid={!name.trim()}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  setDirty(true);
                }}
              />
              <FieldDescription className="text-[11px]">
                Shown wherever this scenario is available.
              </FieldDescription>
              {!name.trim() ? (
                <FieldError>Enter a scenario name.</FieldError>
              ) : null}
            </Field>
            <Field data-invalid={!personaSlug}>
              <FieldLabel>Persona</FieldLabel>
              <Select
                value={personaSlug || undefined}
                onValueChange={(value) =>
                  value !== null && (setPersonaSlug(value), setDirty(true))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a persona" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Workspace personas</SelectLabel>
                    {initial.personas.map((persona) => (
                      <SelectItem key={persona.slug} value={persona.slug}>
                        {persona.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription className="text-[11px]">
                Behavior and communication style the agent runs with.
              </FieldDescription>
              {!personaSlug ? <FieldError>Choose a persona.</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel>Knowledge base</FieldLabel>
              <Select
                value={knowledgeBase || "none"}
                onValueChange={(value) => {
                  if (value === null) return;
                  const nextKnowledgeBase = value === "none" ? "" : value;
                  if (nextKnowledgeBase !== knowledgeBase && interviewConfig.type === "technical") {
                    setInterviewConfig({ ...interviewConfig, topic_slugs: [] });
                  }
                  setKnowledgeBase(nextKnowledgeBase);
                  setDirty(true);
                }}
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
              <FieldDescription className="text-[11px]">
                Only this collection is searched while the scenario runs.{" "}
                <Link href="/knowledge">Manage knowledge</Link>.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Interview type</FieldLabel>
              <Select
                value={interviewConfig.type}
                onValueChange={(value) => {
                  if (value === "resume") {
                    setInterviewConfig({
                      schema_version: 1,
                      type: "resume",
                      follow_ups_per_main_question: interviewConfig.follow_ups_per_main_question,
                      main_questions: interviewConfig.type === "resume" ? interviewConfig.main_questions ?? 4 : 4,
                    });
                  } else if (value === "technical") {
                    setInterviewConfig({
                      schema_version: 1,
                      type: "technical",
                      follow_ups_per_main_question: interviewConfig.follow_ups_per_main_question,
                      topic_slugs: [],
                      question_counts: { ...DEFAULT_TECHNICAL_QUESTION_COUNTS },
                    });
                  }
                  setDirty(true);
                }}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="resume">Resume</SelectItem>
                  <SelectItem value="technical">Technical</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="follow-up-limit">Maximum follow-ups per main question</FieldLabel>
              <Input
                id="follow-up-limit"
                type="number"
                min={0}
                max={3}
                value={interviewConfig.follow_ups_per_main_question}
                onChange={(event) => {
                  setInterviewConfig({ ...interviewConfig, follow_ups_per_main_question: Math.max(0, Math.min(3, Number(event.target.value) || 0)) });
                  setDirty(true);
                }}
              />
              <FieldDescription className="text-xs">Follow-ups are adaptive; this is only the cap.</FieldDescription>
            </Field>
            {interviewConfig.type === "resume" ? (
              <Field>
                <FieldLabel htmlFor="resume-main-questions">Main questions for the session</FieldLabel>
                <Input
                  id="resume-main-questions"
                  type="number"
                  min={1}
                  max={20}
                  value={interviewConfig.main_questions ?? 4}
                  onChange={(event) => {
                    const count = Math.max(1, Math.min(20, Number(event.target.value) || 1));
                    setInterviewConfig({ ...interviewConfig, main_questions: count });
                    setDirty(true);
                  }}
                />
                <FieldDescription className="text-xs">
                  Maximum number of section highlights to question during the session.
                </FieldDescription>
              </Field>
            ) : null}
            {interviewConfig.type === "technical" ? (
              <>
                <Field data-invalid={interviewConfig.topic_slugs.length === 0}>
                  <FieldLabel>Approved topics</FieldLabel>
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border bg-background p-3">
                    {availableTopics.map((topic) => (
                      <label key={topic.slug} className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={interviewConfig.topic_slugs.includes(topic.slug)}
                          onChange={(event) => {
                            const topic_slugs = event.target.checked
                              ? [...interviewConfig.topic_slugs, topic.slug]
                              : interviewConfig.topic_slugs.filter((slug) => slug !== topic.slug);
                            setInterviewConfig({ ...interviewConfig, topic_slugs });
                            setDirty(true);
                          }}
                        />
                        <span className="font-medium">{topic.slug}</span>
                      </label>
                    ))}
                    {!availableTopics.length ? (
                      <p className="text-xs text-muted-foreground">No generated question topics are available for this knowledge base yet.</p>
                    ) : null}
                  </div>
                  {interviewConfig.topic_slugs.length === 0 ? <FieldError>Select at least one approved topic.</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel>Main questions</FieldLabel>
                  <div className="space-y-2 rounded-xl border bg-background p-3">
                    {QUESTION_TYPES.map((type) => (
                      <label key={type} className="flex items-center justify-between gap-3 text-xs">
                        <span>{type}</span>
                        <Input
                          className="h-8 w-20"
                          type="number"
                          min={0}
                          value={interviewConfig.question_counts[type] ?? 0}
                          onChange={(event) => {
                            const count = Math.max(0, Number(event.target.value) || 0);
                            const question_counts = { ...interviewConfig.question_counts };
                            if (count) question_counts[type as QuestionType] = count;
                            else delete question_counts[type as QuestionType];
                            setInterviewConfig({ ...interviewConfig, question_counts });
                            setDirty(true);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <FieldDescription className="text-xs">
                    Total: {Object.values(interviewConfig.question_counts).reduce((sum, count) => sum + count, 0)}
                  </FieldDescription>
                </Field>
              </>
            ) : null}
            <Field>
              <FieldLabel>Voice</FieldLabel>
              <Select
                value={voiceId || "none"}
                onValueChange={(value) =>
                  value !== null &&
                  (setVoiceId(value === "none" ? "" : value), setDirty(true))
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
              <FieldDescription className="text-[11px]">
                Used whenever this scenario speaks.{" "}
                <Link href="/voice">Manage voices</Link>.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </aside>
      </div>
    </main>
  );
}

/** Plate rich-text editor bound to a markdown string via @platejs/markdown. */
function InstructionEditor({
  value,
  onMarkdownChange,
}: {
  value: string;
  onMarkdownChange: (markdown: string) => void;
}) {
  const editor = usePlateEditor({
    plugins: [...BasicNodesKit, ...MarkdownKit],
    value: (editor) =>
      value.trim()
        ? editor.getApi(MarkdownPlugin).markdown.deserialize(value)
        : [{ type: "p", children: [{ text: "" }] }],
  });

  return (
    <Plate
      editor={editor}
      onChange={({ value }) => {
        const markdown = editor
          .getApi(MarkdownPlugin)
          .markdown.serialize({ value }) as string;
        onMarkdownChange(markdown);
      }}
    >
      <EditorContainer className="max-h-150 rounded-xl border bg-background">
        <Editor
          id="agent-instruction"
          aria-label="Scenario instructions"
          variant="none"
          className="min-h-32 px-4 py-3 leading-relaxed"
          placeholder="Describe what this scenario should do and how the agent should behave, operate and assess..."
        />
      </EditorContainer>
    </Plate>
  );
}
