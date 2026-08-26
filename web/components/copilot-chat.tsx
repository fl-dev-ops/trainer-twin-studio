"use client";

import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { FileUIPart, UserContent } from "ai";
import yaml from "js-yaml";
import type { EveDynamicToolPart, EveMessage } from "eve/react";
import { useEveAgent } from "eve/react";
import {
  Check,
  Circle,
  CircleAlert,
  ChevronDown,
  Download,
  FileCode2,
  Layers3,
  ListTodo,
  LoaderCircle,
  Plus,
  Sparkles,
} from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationAction,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { CircularLoader } from "@/components/prompt-kit/loader";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { SpecDraftBundle } from "@/lib/spec-draft-schema";
import { cn } from "@/lib/utils";
import { takeCopilotSeed } from "@/lib/copilot-handoff";

const SESSION_KEY = "trainertwin:spec-copilot-session:v3";
const TOOL_TITLES: Record<string, string> = {
  publish_spec_draft: "Publish trainer",
  read_spec: "Read specification",
  read_spec_draft: "Read working draft",
  save_spec_draft: "Save working draft",
  search_knowledge: "Search trainer knowledge",
  studio_inventory: "Inspect workspace",
};
type DraftView = SpecDraftBundle & {
  status: "draft" | "published";
  revision: number;
};
type Respond = ReturnType<typeof useEveAgent>["respond"];
type TodoItem = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed" | "cancelled";
};
type ArtifactPreview = {
  content: string;
  downloadUrl: string;
  filename: string;
};

const SAFE_MARKDOWN_COMPONENTS = {
  img: ({ alt }: ComponentProps<"img">) => (
    <span className="text-xs text-muted-foreground">[Image omitted{alt ? `: ${alt}` : ""}]</span>
  ),
};

export function CopilotChat() {
  const [savedSession] = useState<{ sessionId: string; streamIndex: number } | undefined>(() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") ?? undefined;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return undefined;
    }
  });
  const [input, setInput] = useState("");
  const [localError, setLocalError] = useState<string>();
  const mountedAt = useRef(Date.now());
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [draft, setDraft] = useState<DraftView>();
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview>();
  const agent = useEveAgent({
    host: "/api",
    initialSession: savedSession,
    resume: savedSession !== undefined,
    onSessionChange(session) {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    },
    onEvent(event) {
      if (event.type === "turn.failed" && Date.parse(event.meta.at) >= mountedAt.current) {
        setLocalError(event.data.code === "MODEL_CALL_FAILED"
          ? "The AI model is temporarily unavailable. Please try again."
          : event.data.message);
      }
    },
  });
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const restoring = savedSession !== undefined && agent.events.length === 0 && busy;
  const draftTarget = findDraftTarget(agent.data.messages);
  const todos = findTodos(agent.data.messages);
  const scopedDraft = draft?.slug === draftTarget.slug ? draft : undefined;
  const workspaceVisible = todos.length > 0 || scopedDraft !== undefined;

  // Send a message queued by another page (e.g. "Design with Copilot" on /agents).
  useEffect(() => {
    if (restoring || busy || agent.data.messages.length > 0) return;
    const seed = takeCopilotSeed();
    if (seed) void send(seed).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!draftTarget.slug) return;
    const controller = new AbortController();
    fetch(`/api/spec-drafts/current?slug=${encodeURIComponent(draftTarget.slug)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.status === 404 ? undefined : response.ok ? response.json() : Promise.reject(new Error("The trainer blueprint could not be loaded.")))
      .then((value: DraftView | undefined) => setDraft(value))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setLocalError(cause instanceof Error ? cause.message : "The trainer blueprint could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [draftTarget.signal, draftTarget.slug]);

  async function send(text: string, files: FileUIPart[] = []) {
    const message = text.trim();
    if ((!message && files.length === 0) || busy) return;
    const content: UserContent = [];
    if (message) content.push({ type: "text", text: message });
    content.push(...files.map(({ mediaType, filename, url }) => ({
      type: "file" as const,
      data: url,
      mediaType,
      filename,
    })));
    setLocalError(undefined);
    setInput("");
    try {
      await agent.send(content);
    } catch (cause) {
      setInput((current) => current || message);
      setLocalError(cause instanceof Error ? cause.message : "Message could not be sent.");
      throw cause;
    }
  }

  function newConversation() {
    localStorage.removeItem(SESSION_KEY);
    setInput("");
    setLocalError(undefined);
    setDraft(undefined);
    setArtifactPreview(undefined);
    setBlueprintOpen(false);
    agent.reset();
  }

  function previewArtifact(type: "agent" | "domain") {
    if (!scopedDraft) return;
    const filename = `${scopedDraft.slug}.${type}.yaml`;
    setArtifactPreview({
      content: yaml.dump({ schema_version: 1, kind: type, [type]: scopedDraft[type] }, { noRefs: true, lineWidth: 100 }),
      downloadUrl: `/api/spec-drafts/${encodeURIComponent(scopedDraft.slug)}/${type}`,
      filename,
    });
  }

  return (
    <main className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      <section className={cn("relative flex min-w-0 flex-1 flex-col", workspaceVisible && "xl:mr-[21rem]")}>
        <header className="pointer-events-none absolute inset-x-0 top-0 z-20 h-20">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-b from-background via-background/70 to-transparent backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_0%,transparent_100%)]"
          />
          <div className="pointer-events-auto relative flex h-12 items-center gap-2 px-3 sm:px-4">
            <SidebarTrigger />
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
              {scopedDraft?.name ?? (agent.data.messages.length > 0 ? "Build a trainer" : "New trainer")}
            </h1>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {workspaceVisible && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Open workspace"
                  onClick={() => setBlueprintOpen(true)}
                  className="size-8 px-0 sm:w-auto sm:px-3 xl:hidden"
                >
                  <Layers3 aria-hidden="true" /> <span className="hidden sm:inline">Workspace</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label="New conversation"
                onClick={newConversation}
                disabled={busy}
                className="size-8 px-0 sm:w-auto sm:px-3"
              >
                <Plus aria-hidden="true" /> <span className="hidden sm:inline">New</span>
              </Button>
            </div>
          </div>
        </header>

        <Conversation className="min-h-0">
          <ConversationContent className="mx-auto min-h-full w-full max-w-3xl px-4 pb-48 pt-20 sm:px-8">
            {agent.data.messages.length === 0 && !restoring ? (
              <ConversationEmptyState title="" description="" className="flex-1">
                <div className="my-auto flex flex-col items-center text-center">
                  <Image src="/trainertwin-mark.svg" alt="" width={37} height={28} priority />
                  <h2 className="mt-6 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                    What should we build?
                  </h2>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                    Describe the learner and the outcome. We’ll shape the trainer from there.
                  </p>
                </div>
              </ConversationEmptyState>
            ) : (
              agent.data.messages.map((message) => (
                <ChatMessage key={message.id} message={message} respond={agent.respond} busy={busy} />
              ))
            )}
            {busy && <Working />}
            {agent.error && (
              <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {agent.error.message}
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton className="bottom-36 z-20" />
        </Conversation>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-5 pt-14 sm:px-6 sm:pb-7">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-b from-transparent to-background backdrop-blur-md [mask-image:linear-gradient(to_bottom,transparent_0%,black_100%)]"
          />
          <div className="relative mx-auto max-w-2xl">
            <PromptInput
              className="pointer-events-auto [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:bg-background/95 [&_[data-slot=input-group]]:shadow-xl [&_[data-slot=input-group]]:shadow-foreground/10"
              accept="image/*,application/pdf,text/plain,text/markdown,.md"
              maxFiles={5}
              maxFileSize={2 * 1024 * 1024}
              multiple
              onError={({ message }) => setLocalError(message)}
              onSubmit={async ({ text, files }) => send(text, files)}
            >
              <PromptAttachments />
              <PromptInputBody>
                <PromptInputTextarea
                  name="message"
                  value={input}
                  onChange={(event) => setInput(event.currentTarget.value)}
                  placeholder="Describe the trainer you want to build…"
                  suppressHydrationWarning
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments label="Add source or context" />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                </PromptInputTools>
                <PromptInputSubmit
                  status={agent.status}
                  onStop={() => void agent.cancel()}
                  aria-label={busy ? "Stop response" : "Send message"}
                />
              </PromptInputFooter>
            </PromptInput>
            {localError && <p role="alert" className="mt-2 text-center text-xs text-destructive">{localError}</p>}
          </div>
        </div>
      </section>

      {workspaceVisible && (
        <>
          <aside className="absolute inset-y-3 right-3 hidden w-80 overflow-y-auto text-sidebar-foreground xl:block">
            <WorkspacePanel draft={scopedDraft} todos={todos} busy={busy} onPreview={previewArtifact} />
          </aside>

          <Sheet open={blueprintOpen} onOpenChange={setBlueprintOpen}>
            <SheetContent className="w-[min(92vw,22rem)] bg-background px-2 pb-2 pt-12 text-sidebar-foreground">
              <SheetHeader className="sr-only">
                <SheetTitle>Trainer workspace</SheetTitle>
                <SheetDescription>Current tasks and generated files.</SheetDescription>
              </SheetHeader>
              <WorkspacePanel draft={scopedDraft} todos={todos} busy={busy} onPreview={previewArtifact} />
            </SheetContent>
          </Sheet>
        </>
      )}

      <Sheet open={artifactPreview !== undefined} onOpenChange={(open) => { if (!open) setArtifactPreview(undefined); }}>
        <SheetContent className="gap-0 p-0 data-[side=right]:w-[min(94vw,48rem)] data-[side=right]:sm:max-w-3xl">
          <SheetHeader className="border-b px-5 py-4 pr-14">
            <div className="flex min-w-0 items-center gap-3">
              <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <SheetTitle className="truncate">{artifactPreview?.filename}</SheetTitle>
                <SheetDescription>Compiled working draft</SheetDescription>
              </div>
              {artifactPreview && (
                <Button
                  className="ml-auto shrink-0"
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<a href={artifactPreview.downloadUrl} />}
                >
                  <Download aria-hidden="true" /> Download
                </Button>
              )}
            </div>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
            {artifactPreview && (
              <CodeBlock code={artifactPreview.content} language="yaml" showLineNumbers className="min-w-full" />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}

function PromptAttachments() {
  const attachments = usePromptInputAttachments();
  if (!attachments.files.length) return null;
  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((file) => (
          <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

function ChatMessage({ message, respond, busy }: { message: EveMessage; respond: Respond; busy: boolean }) {
  const files = message.parts.flatMap((part, index) => part.type === "file" ? [{
    id: `${message.id}-${index}`,
    type: "file" as const,
    mediaType: part.mediaType,
    filename: part.filename,
    url: part.url ?? "",
  }] : []);
  return (
    <Message from={message.role}>
      <MessageContent>
        {files.length > 0 && (
          <Attachments variant="inline">
            {files.map((file) => (
              <Attachment key={file.id} data={file}>
                <AttachmentPreview />
                <AttachmentInfo />
              </Attachment>
            ))}
          </Attachments>
        )}
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return message.role === "assistant" ? (
              <MessageResponse
                key={index}
                components={SAFE_MARKDOWN_COMPONENTS}
                mode={part.state === "streaming" ? "streaming" : "static"}
                isAnimating={part.state === "streaming"}
                linkSafety={{ enabled: true }}
              >
                {part.text}
              </MessageResponse>
            ) : <p key={index} className="whitespace-pre-wrap">{part.text}</p>;
          }
          if (part.type === "dynamic-tool") {
            if (part.toolName === "todo") return null;
            return <ToolPartView key={part.toolCallId} part={part} respond={respond} busy={busy} />;
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}

function ToolPartView({ part, respond, busy }: { part: EveDynamicToolPart; respond: Respond; busy: boolean }) {
  const request = part.toolMetadata?.eve?.inputRequest;
  const [answer, setAnswer] = useState("");
  const title = TOOL_TITLES[part.toolName] ?? part.toolName.replaceAll("_", " ");

  if (request && part.state === "approval-requested") {
    const approval = "approval" in part ? part.approval : undefined;
    return (
      <Confirmation approval={approval} state={part.state}>
        <ConfirmationTitle>{request.kind === "tool-approval" ? "Review before publishing" : "One decision needed"}</ConfirmationTitle>
        <ConfirmationRequest>
          <p className="text-sm">{request.prompt}</p>
          {request.options && (
            <ConfirmationActions>
              {request.options.map((option) => (
                <ConfirmationAction
                  key={option.id}
                  variant={option.style === "primary" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void respond([{ requestId: request.requestId, optionId: option.id }])}
                >
                  {option.label}
                </ConfirmationAction>
              ))}
            </ConfirmationActions>
          )}
          {request.allowFreeform && (
            <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) void respond([{ requestId: request.requestId, text: answer.trim() }]); }}>
              <input value={answer} onChange={(event) => setAnswer(event.target.value)} aria-label="Your answer" className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
              <Button size="sm" type="submit" disabled={!answer.trim() || busy}>Answer</Button>
            </form>
          )}
        </ConfirmationRequest>
      </Confirmation>
    );
  }

  return (
    <div
      className="not-prose flex min-h-7 items-center gap-2 py-1 text-sm"
      title={part.state === "output-error" ? part.errorText : undefined}
    >
      <ToolStateIcon state={part.state} />
      <span className="font-medium">tool_call</span>
      <span className="truncate text-xs text-muted-foreground">{title}</span>
    </div>
  );
}

function ToolStateIcon({ state }: { state: EveDynamicToolPart["state"] }) {
  if (state === "input-available" || state === "input-streaming") {
    return <CircularLoader size="sm" className="shrink-0" />;
  }
  if (state === "output-available" || state === "approval-responded") {
    return <Check className="size-4 shrink-0 text-muted-foreground" aria-label="Completed" />;
  }
  return <CircleAlert className="size-4 shrink-0 text-destructive" aria-label={state === "approval-requested" ? "Waiting for input" : "Tool error"} />;
}

function WorkspacePanel({
  draft,
  todos,
  busy,
  onPreview,
}: {
  draft?: DraftView;
  todos: TodoItem[];
  busy: boolean;
  onPreview: (type: "agent" | "domain") => void;
}) {
  const items = todos.length > 0 ? todos : [
    ...(draft?.gaps.map((content) => ({ content, priority: "high" as const, status: "pending" as const })) ?? []),
    ...(draft?.assumptions.map((content) => ({ content: `Confirm: ${content}`, priority: "low" as const, status: "pending" as const })) ?? []),
  ];

  return (
    <div className="flex min-h-full flex-col gap-3 p-1 sm:p-3">
      {items.length > 0 && (
        <WorkspaceCard icon={ListTodo} title="Todo">
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => {
              const completed = item.status === "completed";
              const working = item.status === "in_progress" && busy;
              const Icon = completed ? Check : working ? LoaderCircle : item.status === "cancelled" ? CircleAlert : Circle;
              return (
                <li key={`${item.content}-${index}`} className="flex gap-2 rounded-lg px-2 py-2 text-sm hover:bg-sidebar-accent">
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${working ? "animate-spin text-brand" : completed ? "text-foreground" : "text-muted-foreground"}`}
                    aria-label={completed ? "Completed" : working ? "In progress" : item.status === "cancelled" ? "Cancelled" : "Pending"}
                  />
                  <span className={completed ? "text-muted-foreground line-through" : "text-sidebar-foreground"}>{item.content}</span>
                </li>
              );
            })}
          </ul>
        </WorkspaceCard>
      )}

      {draft && (
        <WorkspaceCard icon={FileCode2} title="Content">
          <div className="flex flex-col gap-0.5">
            {(["agent", "domain"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onPreview(type)}
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{draft.slug}.{type}.yaml</span>
              </button>
            ))}
          </div>
        </WorkspaceCard>
      )}
    </div>
  );
}

function WorkspaceCard({ icon: Icon, title, children }: { icon: typeof ListTodo; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group overflow-hidden rounded-xl border bg-sidebar shadow-sm"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring [&::-webkit-details-marker]:hidden">
        <Icon className="size-3.5" aria-hidden="true" />
        <span>{title}</span>
        <ChevronDown className="ml-auto size-3.5 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t px-1 py-1.5">{children}</div>
    </details>
  );
}

function Working() {
  return <Message from="assistant"><MessageContent><p className="flex items-center gap-2 text-xs text-muted-foreground"><Sparkles className="size-3.5" /> Working…</p></MessageContent></Message>;
}

function findTodos(messages: readonly EveMessage[]): TodoItem[] {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (part.type !== "dynamic-tool" || part.toolName !== "todo") continue;
      const value = part.state === "output-available" ? part.output : "input" in part ? part.input : undefined;
      if (!value || typeof value !== "object" || !("todos" in value) || !Array.isArray(value.todos)) return [];
      return value.todos.filter((item): item is TodoItem => {
        if (!item || typeof item !== "object") return false;
        const todo = item as Record<string, unknown>;
        return typeof todo.content === "string"
          && ["high", "medium", "low"].includes(String(todo.priority))
          && ["pending", "in_progress", "completed", "cancelled"].includes(String(todo.status));
      });
    }
  }
  return [];
}

function findDraftTarget(messages: readonly EveMessage[]) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (part.type !== "dynamic-tool") continue;
      if (part.toolName !== "save_spec_draft" && part.toolName !== "read_spec_draft") continue;
      const output = part.state === "output-available" ? part.output : undefined;
      const slug = output && typeof output === "object" && "slug" in output && typeof output.slug === "string" ? output.slug : undefined;
      return { signal: `${part.toolCallId}:${part.state}`, slug };
    }
  }
  return { signal: "initial", slug: undefined };
}

