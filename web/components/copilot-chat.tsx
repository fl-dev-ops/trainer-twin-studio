"use client";

import type { ComponentProps, CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { Route } from "next";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { FileUIPart } from "ai";
import type { EveMessage, EveToolPart } from "eve/react";
import { useEveAgent } from "eve/react";
import {
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  CircleSlash,
  ChevronDown,
  CornerDownRight,
  Layers3,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  PictureInPicture2,
  Plus,
  X,
} from "lucide-react";
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
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { CircularLoader } from "@/components/prompt-kit/loader";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type CopilotStatus, useCopilotPanel } from "@/components/copilot/panel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AttachFileButton,
  ComposerHeader,
  COPILOT_ATTACH_ACCEPT,
  COPILOT_ATTACH_MAX_FILES,
  CopilotChips,
  KnowledgeFilePicker,
  knowledgeDocUrl,
  knowledgeMediaType,
  MessageFileCard,
  SkillMenu,
} from "@/components/copilot-composer";
import { duringUploadProblem, UPLOAD_MAX_BYTES } from "@/lib/context-upload";
import { copilotUploadFilename, copilotUploadOf, copilotUploadUrl, uploadFile } from "@/lib/upload-client";
import {
  type CopilotSkillName,
  decodeCopilotMessage,
  encodeCopilotMessage,
  matchingSkills,
  type PickedFile,
  slashQuery,
} from "@/lib/copilot-message";
import {
  copilotInputKey,
  copilotSessionKey,
  hasCopilotSeed,
  LEGACY_COPILOT_KEYS,
  takeCopilotSeed,
} from "@/lib/copilot-handoff";
import { type CopilotPage, copilotPageOf, homeStarters, startersFor } from "@/lib/copilot-page";
import { dashRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useRefresh } from "@/lib/use-refresh";

const TOOL_TITLES: Record<string, string> = {
  eve__skill: "Load skill",
  knowledge_list: "List knowledge files",
  knowledge_search: "Search knowledge",
  knowledge_read: "Read sources",
  attachment_read: "Read attachment",
  note_read: "Read notes",
  roleplay_recording_sessions_read: "Read sessions",
  roleplay_recording_method_read: "Read method docs",
  twin_list: "List twins",
  twin_read: "Read twin",
  roleplay_list: "List role plays",
  roleplay_read: "Read role play",
  persona_list: "List personas",
  voice_list: "List voices",
  user_list: "List users",
  twin_create: "Create twin",
  persona_create: "Create persona",
  twin_skill_build: "Build twin skill",
  twin_skill_load: "Load twin skill",
  twin_skill_publish: "Publish twin skill",
  roleplay_draft: "Draft role play",
  roleplay_publish: "Publish role play",
  roleplay_recording_build: "Build role play",
  roleplay_recording_check: "Check role play",
  roleplay_recording_load: "Load role play",
  roleplay_recording_publish: "Publish role play",
  twin_update: "Change twin",
  twin_settings_update: "Change twin settings",
  roleplay_update: "Change role play",
  roleplay_settings_update: "Change role-play settings",
  roleplay_tools_update: "Change role-play tools",
  persona_update: "Change persona",
  note_write: "Write notes",
  twin_skills_set: "Change twin skills",
  roleplay_personas_set: "Change role-play personas",
  roleplay_character_set: "Write persona character",
  bot_list: "List website bots",
  bot_read: "Read website bot",
  bot_create: "Create website bot",
  bot_update: "Change website bot",
  session_list: "List sessions",
  session_read: "Read session",
  calibration_list: "List calibrations",
  usage_read: "Read usage",
  team_list: "List team",
  org_read: "Read organization",
};

/**
 * A tool row as the trainer reads it: what's happening ("Reading knowledge") while it runs, what happened ("Read
 * knowledge") once done. Titles start with their verb (TOOL_TITLES); an unknown verb keeps the title as it is.
 */
const VERBS: Record<string, [doing: string, done: string]> = {
  Read: ["Reading", "Read"],
  List: ["Listing", "Listed"],
  Search: ["Searching", "Searched"],
  Load: ["Loading", "Loaded"],
  Create: ["Creating", "Created"],
  Build: ["Building", "Built"],
  Publish: ["Publishing", "Published"],
  Draft: ["Drafting", "Drafted"],
  Check: ["Checking", "Checked"],
  Change: ["Changing", "Changed"],
  Write: ["Writing", "Wrote"],
};
function toolPhrase(title: string, tense: "doing" | "done") {
  const [verb, ...rest] = title.split(" ");
  const forms = VERBS[verb];
  if (!forms) return title;
  const object = rest.join(" ");
  return `${forms[tense === "doing" ? 0 : 1]}${object ? ` ${object.charAt(0).toLowerCase()}${object.slice(1)}` : ""}`;
}
const toolTitle = (part: EveToolPart) => TOOL_TITLES[part.name] ?? part.label ?? part.name;
/** The copilot's tools that change the studio (they all ask for approval): twin_update, persona_create, roleplay_publish… */
const isWriteTool = (name: string) => /_(create|update|set|publish)$/.test(name);
const isRunning = (state: EveToolPart["state"]) => state === "streaming" || state === "requested" || state === "running";

/** What the copilot is doing right now, for the waiting line: its latest running tool, or thinking. */
function currentActivity(messages: readonly EveMessage[]): string {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    for (let index = last.parts.length - 1; index >= 0; index--) {
      const part = last.parts[index];
      if (part.type === "tool" && part.name !== "todo" && part.kind !== "control" && isRunning(part.state)) {
        return toolPhrase(toolTitle(part), "doing");
      }
    }
  }
  return "Thinking";
}

/** The conversation's name for the panel header: the first thing the trainer asked, without the composer's tags. */
function conversationTitle(messages: readonly EveMessage[]): string | null {
  const first = messages.find((message) => message.role === "user");
  const text = first?.parts.find((part) => part.type === "text");
  if (!text || text.type !== "text") return null;
  const plain = decodeCopilotMessage(text.text).text.replace(/^USER=.*\n/, "").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 80) : null;
}

/**
 * The studio page the panel sits beside, named the way the trainer knows it: the section from the URL, refined by
 * the page's own heading once it has loaded (pages load their data in the browser, so the heading comes a beat later).
 */
function useCurrentPage(enabled: boolean): CopilotPage | null {
  const pathname = usePathname();
  const [heading, setHeading] = useState<{ path: string; text: string | null }>({ path: pathname, text: null });
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      // The page title, or on detail pages (a Back link instead of a title) the first heading: the item's name.
      const inset = document.querySelector('[data-slot="sidebar-inset"]');
      const text = (inset?.querySelector('[data-slot="page-header"] h1') ?? inset?.querySelector("h1, h2"))?.textContent ?? null;
      setHeading((current) => (current.path === pathname && current.text === text ? current : { path: pathname, text }));
    };
    read();
    const root = document.querySelector('[data-slot="sidebar-inset"]');
    if (!root) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [enabled, pathname]);
  if (!enabled) return null;
  return copilotPageOf(pathname, heading.path === pathname ? heading.text : null);
}
type Respond = ReturnType<typeof useEveAgent>["respond"];
type TodoItem = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed" | "cancelled";
};
const SAFE_MARKDOWN_COMPONENTS = {
  img: ({ alt }: ComponentProps<"img">) => (
    <span className="text-xs text-muted-foreground">
      [Image omitted{alt ? `: ${alt}` : ""}]
    </span>
  ),
};

type SavedSession = { sessionId: string; streamIndex: number };
type ChatScope = { sessionKey: string; inputKey: string; savedSession?: SavedSession };

/** A saved conversation is resumable when its owner (this user, this org) can still open it: not gone, not another org's. */
async function resumable(sessionId: string): Promise<boolean> {
  const controller = new AbortController();
  try {
    const response = await fetch(
      `/api/eve/v1/session/${encodeURIComponent(sessionId)}/stream?streamControlVersion=1&includeTailIndex=1`,
      { cache: "no-store", signal: controller.signal },
    );
    if (response.status === 404 || response.status === 403) return false;
    if (response.status === 409) {
      // "stranded" (built by an older copilot deploy) or an earlier eve protocol can never continue; "not ready yet" can.
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      return body?.code !== "session_stranded" && body?.code !== "session_version_unsupported";
    }
    return true;
  } catch {
    return true; // offline or aborted: let the chat retry as before
  } finally {
    controller.abort(); // only the status was needed, not the stream
  }
}

/**
 * The copilot chat for the signed-in trainer in this tab's org. Each user + org has its own saved conversation, so
 * switching org never shows (or continues) the other org's chat; a saved conversation that is gone or isn't theirs
 * starts a fresh one instead of retrying forever.
 */
export function CopilotChat(props: { variant?: "page" | "panel"; onExpand?: () => void }) {
  const [scope, setScope] = useState<ChatScope | "error">();

  useEffect(() => {
    let live = true;
    (async () => {
      for (const key of LEGACY_COPILOT_KEYS) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }
      const response = await fetch("/api/copilot/me", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const me = (await response.json()) as { userId: string; orgId: string };
      const sessionKey = copilotSessionKey(me.userId, me.orgId);
      let savedSession: SavedSession | undefined;
      try {
        savedSession = JSON.parse(localStorage.getItem(sessionKey) ?? "null") ?? undefined;
      } catch {
        savedSession = undefined;
      }
      // A queued message from another page starts a new conversation.
      if (savedSession && (hasCopilotSeed() || !(await resumable(savedSession.sessionId)))) {
        localStorage.removeItem(sessionKey);
        savedSession = undefined;
      }
      if (live) setScope({ sessionKey, inputKey: copilotInputKey(me.userId, me.orgId), savedSession });
    })().catch(() => live && setScope("error"));
    return () => {
      live = false;
    };
  }, []);

  if (scope === "error") {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-background p-6">
        <p role="alert" className="text-sm text-muted-foreground">Copilot couldn&apos;t load. Refresh the page to try again.</p>
      </main>
    );
  }
  if (!scope) return props.variant === "panel" ? <CopilotPanelSkeleton /> : <main className="min-h-0 flex-1 bg-background" aria-busy="true" />;
  return <CopilotConversation key={scope.sessionKey} {...props} {...scope} />;
}

function CopilotConversation({
  variant = "page",
  onExpand,
  sessionKey,
  inputKey,
  savedSession,
}: {
  variant?: "page" | "panel";
  onExpand?: () => void;
} & ChatScope) {
  const panel = variant === "panel";
  const copilot = useCopilotPanel();
  const root = useRef<HTMLElement>(null);
  const page = useCurrentPage(panel);
  // × on the page chip leaves the page out of the next message only; another page brings it back.
  const [droppedPage, setDroppedPage] = useState<string | null>(null);
  const sentPage = page && droppedPage !== page.path ? page : undefined;
  const SESSION_KEY = sessionKey;
  const INPUT_KEY = inputKey;
  const [input, setInput] = useState(
    () => sessionStorage.getItem(INPUT_KEY) ?? "",
  );
  const [localError, setLocalError] = useState<string>();
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  // Composer extras: the skill picked from "/", knowledge files picked from Files, the highlighted "/" entry.
  const [skill, setSkill] = useState<CopilotSkillName>();
  const [pickedFiles, setPickedFiles] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const agent = useEveAgent({
    baseUrl: "/api",
    initialSession: savedSession,
    resume: savedSession !== undefined,
    onSessionChange(session) {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    },
  });
  // While the copilot waits on an approval card, that wait is the trainer's turn, not "busy",
  // or the card's own buttons (and the composer) would be disabled.
  const awaitingApproval = agent.messages.some((message) =>
    message.parts.some((part) => part.type === "tool" && part.interaction?.status === "open"),
  );
  const restoring = agent.status === "resuming";
  const busy = agent.status === "busy" && !awaitingApproval;
  const todos = findTodos(agent.messages);
  const workspaceVisible = todos.length > 0;
  const showWorkspace = !panel && workspaceVisible;
  const slash = skill ? null : slashQuery(input);
  const slashSkills = slash === null ? [] : matchingSkills(slash);
  const status: CopilotStatus = awaitingApproval ? "needs-you" : busy || uploading ? "working" : "idle";
  const title = conversationTitle(agent.messages);

  // The launcher shows what this conversation is doing while the copilot is closed (components/copilot/pill.tsx).
  const report = copilot?.report;
  const activity = currentActivity(agent.messages);
  useEffect(() => {
    report?.(status, activity);
  }, [report, status, activity]);

  // A change the copilot makes shows on the page beside it: when a write it was seen running finishes, the page's
  // data reloads. Writes seen only already done (a resumed conversation) don't reload anything.
  const refreshPage = useRefresh();
  const pendingWrites = useRef(new Set<string>());
  useEffect(() => {
    let changed = false;
    for (const message of agent.messages) {
      for (const part of message.parts) {
        if (part.type !== "tool" || !isWriteTool(part.name)) continue;
        if (part.state === "completed") {
          if (pendingWrites.current.delete(part.callId)) changed = true;
        } else if (isRunning(part.state) || part.state === "approval" || part.state === "blocked") {
          pendingWrites.current.add(part.callId);
        } else {
          pendingWrites.current.delete(part.callId);
        }
      }
    }
    if (changed) refreshPage();
  }, [agent.messages, refreshPage]);

  // Opening the panel (or ⌘J on home) puts you in the composer; a first load of home doesn't steal focus.
  const focusSignal = copilot?.focusSignal ?? 0;
  useEffect(() => {
    if (!panel && focusSignal === 0) return;
    root.current?.querySelector<HTMLTextAreaElement>("[data-copilot-composer] textarea")?.focus({ preventScroll: true });
  }, [panel, focusSignal]);

  // Send a message queued by another page (e.g. "Create a twin skill" on the twin agents page).
  useEffect(() => {
    if (restoring || busy || agent.messages.length > 0) return;
    const seed = takeCopilotSeed();
    if (seed) void send(seed).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickSkill(name: CopilotSkillName) {
    setSkill(name);
    setInput("");
    sessionStorage.removeItem(INPUT_KEY);
    setSlashActive(0);
  }

  async function send(text: string, files: FileUIPart[] = []) {
    const typed = text.trim();
    if ((!typed && files.length === 0 && pickedFiles.length === 0) || busy || restoring || uploading) return;
    setLocalError(undefined);
    // Attached files go to S3 first; the message carries pointers the copilot loads (copilot/agent/lib/uploads.ts).
    let uploaded: { id: string; name: string; mediaType: string }[] = [];
    if (files.length) {
      setUploading(true);
      try {
        uploaded = await Promise.all(files.map(async ({ url, filename, mediaType }) => {
          const blob = await (await fetch(url)).blob();
          const file = new File([blob], filename || "file", { type: mediaType || blob.type });
          const problem = duringUploadProblem(file);
          if (problem) throw new Error(`${file.name}: ${problem}`);
          const saved = await uploadFile(file, { purpose: "copilot" });
          return { id: saved.id, name: saved.name, mediaType: file.type };
        }));
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : "The file could not be uploaded.");
        throw cause;
      } finally {
        setUploading(false);
      }
    }
    const message = encodeCopilotMessage({ page: sentPage, skill, files: pickedFiles, text: typed });
    const content = [
      ...(message ? [{ type: "text" as const, text: message }] : []),
      ...uploaded.map(({ id, name, mediaType }) => ({
        type: "file" as const,
        data: copilotUploadUrl(id),
        mediaType,
        filename: copilotUploadFilename(id, name),
      })),
    ];
    setInput("");
    sessionStorage.removeItem(INPUT_KEY);
    const sentSkill = skill;
    const sentFiles = pickedFiles;
    setSkill(undefined);
    setPickedFiles([]);
    setDroppedPage(null);
    try {
      await agent.send(content);
    } catch (cause) {
      setSkill((current) => current ?? sentSkill);
      setPickedFiles((current) => (current.length ? current : sentFiles));
      setInput((current) => {
        const restored = current || typed;
        if (restored) sessionStorage.setItem(INPUT_KEY, restored);
        return restored;
      });
      setLocalError(
        cause instanceof Error ? cause.message : "Message could not be sent.",
      );
      throw cause;
    }
  }

  function newConversation() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(INPUT_KEY);
    setInput("");
    setLocalError(undefined);
    setSkill(undefined);
    setPickedFiles([]);
    setBlueprintOpen(false);
    agent.newSession();
  }

  // A starter fills the composer (it doesn't send): the trainer adds the details, caret at the end.
  const start = (text: string) => {
    setInput(text);
    sessionStorage.setItem(INPUT_KEY, text);
    requestAnimationFrame(() => {
      const box = root.current?.querySelector<HTMLTextAreaElement>("[data-copilot-composer] textarea");
      box?.focus();
      box?.setSelectionRange(text.length, text.length);
    });
  };
  const roleplay = copilot?.roleplay ?? true;
  const floating = panel && copilot?.layout === "floating";

  const content = (
    <main
      ref={root}
      className={cn(
        "relative flex min-h-0 flex-1 overflow-hidden",
        // The panel takes the rail's tone, so the page between them stays the one bright surface.
        panel ? "h-full bg-sidebar text-sidebar-foreground" : "bg-background",
      )}
    >
      <section
        className={cn(
          "relative flex min-w-0 flex-1 flex-col",
          showWorkspace && "xl:mr-84",
        )}
      >
        <header
          className={cn(
            "z-20 h-12 shrink-0",
            panel
              ? " bg-sidebar"
              : "pointer-events-none absolute inset-x-0 top-0 h-20",
          )}
        >
          {!panel && (
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-linear-to-b from-background via-background/70 to-transparent backdrop-blur-md mask-fade-b"
            />
          )}
          <div
            className={cn(
              "relative flex h-12 items-center gap-2 px-3 sm:px-4",
              !panel && "pointer-events-auto",
            )}
          >
            {!panel && <SidebarTrigger />}
            <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-medium">
              <span className="shrink-0">Copilot</span>
              {title && (
                // The conversation's name settles in once there is one, quieter than "Copilot".
                <span key={title} className="animate-copilot-chip truncate font-normal text-muted-foreground" title={title}>
                  {title}
                </span>
              )}
            </h1>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {showWorkspace && (
                <Button
                  variant="ghost"
                  aria-label="Open workspace"
                  onClick={() => setBlueprintOpen(true)}
                  className="xl:hidden"
                >
                  <Layers3 data-icon="inline-start" aria-hidden="true" />{" "}
                  <span className="hidden sm:inline">Workspace</span>
                </Button>
              )}
              {floating ? (
                <>
                  <HeaderAction label="New conversation" onClick={newConversation} disabled={busy}>
                    <Plus />
                  </HeaderAction>
                  <HeaderAction label="Dock beside the page" onClick={() => copilot?.setLayout("docked")}>
                    <PanelRight />
                  </HeaderAction>
                  <HeaderAction
                    label={copilot?.expanded ? "Shrink" : "Expand"}
                    onClick={() => copilot?.setExpanded(!copilot.expanded)}
                  >
                    {copilot?.expanded ? <Minimize2 /> : <Maximize2 />}
                  </HeaderAction>
                  <HeaderAction label="Minimize" shortcut onClick={() => copilot?.setOpen(false)}>
                    <Minus />
                  </HeaderAction>
                </>
              ) : panel ? (
                <>
                  <HeaderAction label="New conversation" onClick={newConversation} disabled={busy}>
                    <Plus />
                  </HeaderAction>
                  {/* On a phone the copilot is always a full-screen sheet, so there's no layout to switch to. */}
                  <span className="hidden md:contents">
                    <HeaderAction label="Float over the page" onClick={() => copilot?.setLayout("floating")}>
                      <PictureInPicture2 />
                    </HeaderAction>
                  </span>
                  <HeaderAction label="Open full page" href={dashRoute("/")} onClick={onExpand}>
                    <Maximize2 />
                  </HeaderAction>
                  <HeaderAction label="Close" shortcut onClick={() => copilot?.setOpen(false)}>
                    <X />
                  </HeaderAction>
                </>
              ) : (
                <Button
                  variant="ghost"
                  aria-label="New conversation"
                  onClick={newConversation}
                  disabled={busy}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" />{" "}
                  <span className="hidden sm:inline">New</span>
                </Button>
              )}
            </div>
          </div>
        </header>

        <Conversation className="min-h-0">
          <ConversationContent
            className={cn(
              "mx-auto min-h-full w-full max-w-3xl pb-48",
              panel ? "px-4 pt-8" : "px-4 pt-20 sm:px-8",
            )}
          >
            {panel && workspaceVisible && (
              <WorkspacePanel todos={todos} busy={busy} />
            )}
            {agent.messages.length === 0 && !restoring && panel ? (
              <PanelWelcome page={page} roleplay={roleplay} onStart={start} />
            ) : agent.messages.length === 0 && !restoring ? (
              <HomeWelcome roleplay={roleplay} onStart={start} />
            ) : (
              agent.messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  respond={agent.respond}
                  busy={busy}
                />
              ))
            )}
            {busy && <Working activity={currentActivity(agent.messages)} />}
            {agent.error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {agent.error.name === "MODEL_CALL_FAILED"
                  ? "The AI model is temporarily unavailable. Please try again."
                  : agent.error.message}
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton className="bottom-36 z-20" />
        </Conversation>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-4 pt-14">
          <div
            aria-hidden="true"
            className={cn(
              "absolute inset-0 bg-linear-to-b from-transparent backdrop-blur-md mask-fade-t",
              panel ? "to-sidebar" : "to-background",
            )}
          />
          {/* In the panel and the floating card the composer spans the card, lined up with the messages above it. */}
          <div className={cn("relative mx-auto", panel ? "max-w-3xl" : "max-w-2xl")}>
            {slash !== null && (
              <SkillMenu
                skills={slashSkills}
                active={Math.min(slashActive, Math.max(0, slashSkills.length - 1))}
                onPick={pickSkill}
                onHover={setSlashActive}
              />
            )}
            <PromptInput
              data-copilot-composer=""
              className="pointer-events-auto **:data-[slot=input-group]:rounded-2xl **:data-[slot=input-group]:bg-background! "
              // Images and PDFs for this conversation (kept 30 days); lasting material goes in the knowledge base.
              accept={COPILOT_ATTACH_ACCEPT}
              multiple
              maxFiles={COPILOT_ATTACH_MAX_FILES}
              maxFileSize={UPLOAD_MAX_BYTES}
              onError={({ code, message }) =>
                // PromptInput reports this from inside its own state update: set ours after it.
                queueMicrotask(() =>
                  setLocalError(
                    code === "accept"
                      ? "Attach an image (PNG, JPEG or WebP) or a PDF. For other files, add them to your knowledge base in Twin's brain, then pick them with Files."
                      : code === "max_file_size"
                        ? "That file is over 10 MB. Use a smaller one."
                        : code === "max_files"
                          ? `Up to ${COPILOT_ATTACH_MAX_FILES} files per message.`
                          : message,
                  ),
                )
              }
              onSubmit={async ({ text, files }) => send(text, files)}
            >
              <ComposerHeader
                page={sentPage}
                onRemovePage={page ? () => setDroppedPage(page.path) : undefined}
                skill={skill}
                files={pickedFiles}
                onRemoveSkill={() => setSkill(undefined)}
                onRemoveFile={(id) => setPickedFiles((files) => files.filter((file) => file.id !== id))}
              />
              <PromptInputBody>
                <PromptInputTextarea
                  name="message"
                  value={input}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setInput(value);
                    setSlashActive(0);
                    if (value) sessionStorage.setItem(INPUT_KEY, value);
                    else sessionStorage.removeItem(INPUT_KEY);
                  }}
                  onKeyDown={(event) => {
                    // Esc in an empty composer puts the panel away (focus goes back to the page).
                    // Floating and expanded, it first folds back to the card; the next Esc puts it away.
                    if (event.key === "Escape" && slash === null && panel && !event.currentTarget.value) {
                      event.preventDefault();
                      if (floating && copilot?.expanded) copilot.setExpanded(false);
                      else copilot?.setOpen(false);
                      return;
                    }
                    // The "/" menu owns the arrows, Enter/Tab and Escape while it is open.
                    if (slash === null) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const step = event.key === "ArrowDown" ? 1 : -1;
                      setSlashActive((index) => (slashSkills.length ? (index + step + slashSkills.length) % slashSkills.length : 0));
                    } else if ((event.key === "Enter" || event.key === "Tab") && slashSkills.length) {
                      event.preventDefault();
                      pickSkill(slashSkills[Math.min(slashActive, slashSkills.length - 1)].name);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setInput("");
                    }
                  }}
                  placeholder={
                    skill
                      ? "What should it build or update?"
                      : panel
                        ? page
                          ? "Ask about this page, or type / for skills"
                          : "Ask Copilot, or type / for skills"
                        : "What should we work on? Type / for skills"
                  }
                  suppressHydrationWarning
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <AttachFileButton disabled={busy || uploading} />
                  <KnowledgeFilePicker selected={pickedFiles} onChange={setPickedFiles} disabled={busy} />
                </PromptInputTools>
                <PromptInputSubmit
                  status={uploading || restoring ? "submitted" : busy ? "streaming" : "ready"}
                  onStop={() => void agent.cancel()}
                  aria-label={busy ? "Stop response" : "Send message"}
                />
              </PromptInputFooter>
            </PromptInput>
            {localError && (
              <p
                role="alert"
                className="mt-2 text-center text-xs text-destructive"
              >
                {localError}
              </p>
            )}
          </div>
        </div>
      </section>

      {showWorkspace && (
        <>
          <aside className="absolute inset-y-3 right-3 hidden w-80 overflow-y-auto text-sidebar-foreground xl:block">
            <WorkspacePanel todos={todos} busy={busy} />
          </aside>

          <Sheet open={blueprintOpen} onOpenChange={setBlueprintOpen}>
            <SheetContent className="w-[min(92vw,24.2rem)] px-2 pb-2 pt-12">
              <SheetHeader className="sr-only">
                <SheetTitle>Scenario workspace</SheetTitle>
                <SheetDescription>
                  Current scenario tasks.
                </SheetDescription>
              </SheetHeader>
              <WorkspacePanel todos={todos} busy={busy} />
            </SheetContent>
          </Sheet>
        </>
      )}

    </main>
  );

  return content;
}

/**
 * The panel while the chat loads (first open): its header and composer where the real ones will be, so the
 * conversation fills in instead of the panel jumping from empty to full.
 */
export function CopilotPanelSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading Copilot" className="flex h-full min-h-0 flex-1 flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center px-3 text-sm font-medium sm:px-4">Copilot</div>
      <div className="mt-auto px-3 pb-4">
        <div className="mx-auto h-[7.25rem] max-w-2xl rounded-2xl border border-sidebar-border bg-background" />
      </div>
    </div>
  );
}

/** The panel header's icon buttons, with a tooltip each (Close also names its shortcut). */
function HeaderAction({
  label,
  href,
  onClick,
  disabled,
  shortcut,
  children,
}: {
  label: string;
  href?: Route;
  onClick?: () => void;
  disabled?: boolean;
  shortcut?: boolean;
  children: React.ReactNode;
}) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? (
            <Button variant="ghost" iconOnly aria-label={label} nativeButton={false} render={<Link href={href} onClick={onClick} />} />
          ) : (
            <Button variant="ghost" iconOnly aria-label={label} onClick={onClick} disabled={disabled} />
          )
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut && <Kbd>{mac ? "⌘J" : "Ctrl J"}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The panel's first screen: where you are, and a couple of things to start from on this page, only ones the copilot
 * can do today (lib/copilot-page.ts). Picking one fills the composer rather than sending it, so you can add the details.
 */
function PanelWelcome({ page, roleplay, onStart }: { page: CopilotPage | null; roleplay: boolean; onStart: (text: string) => void }) {
  // Sits just above the composer, where your eyes and hands already are, rather than floating mid-panel.
  return (
    <div className="mt-auto flex w-full flex-col items-start gap-5 px-1 pb-2 text-left">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-title-s font-semibold tracking-title text-balance">
          {page ? <>Working on <span className="text-foreground">{page.title}</span>?</> : "What should we work on?"}
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {roleplay
            ? "I build and update twin skills and role plays from your knowledge, set them up, and create personas."
            : "I build and update your twin’s skills from your knowledge, and set your twin up."}
        </p>
      </div>
      <ul className="flex w-full flex-col gap-1" aria-label="Ways to start">
        {startersFor(page, { roleplay }).map((starter, index) => (
          // Each starter settles in a beat after the one above it.
          <li key={starter.text} className="animate-copilot-chip [animation-delay:calc(80ms+var(--i)*40ms)]" style={{ "--i": index } as CSSProperties}>
            <button
              type="button"
              onClick={() => onStart(starter.text)}
              className="group/start flex w-full items-center gap-2.5 rounded-tt-sm px-2.5 py-2 text-left text-sm text-(--text-secondary) outline-none transition-colors hover:bg-(--tone-control) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-(--ease-studio) group-hover/start:translate-x-0.5" aria-hidden="true" />
              {starter.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A heading whose words rise in one after another (as the website widget's do): it reads as being said, once. */
function RisingWords({ text, className }: { text: string; className?: string }) {
  return (
    <h2 className={className} aria-label={text}>
      {text.split(" ").map((word, index) => (
        <span key={`${text}-${index}`} aria-hidden className="animate-copilot-word inline-block" style={{ "--i": index } as CSSProperties}>
          {word}
          {index < text.split(" ").length - 1 ? "\u00a0" : ""}
        </span>
      ))}
    </h2>
  );
}

/**
 * Home, the full-page copilot with nothing said yet. Lined up with the composer's left edge and sitting just above it
 * (as the panel's welcome does), with the four main ways in for what this org uses as plain text, not cards: a title,
 * a quiet hint, and an arrow that comes in on hover. One fills the composer (it doesn't send), for the specifics.
 */
function HomeWelcome({ roleplay, onStart }: { roleplay: boolean; onStart: (text: string) => void }) {
  return (
    <div className="mx-auto mt-auto flex w-full max-w-2xl flex-col gap-8 px-1 pb-4">
      <div className="flex flex-col gap-3">
        <Image src="/trainertwin-mark.svg" alt="" width={26} height={20} priority className="animate-copilot-chip" />
        <RisingWords text="What should we work on?" className="text-2xl font-semibold tracking-title text-balance sm:text-3xl" />
        <p className="animate-copilot-chip max-w-lg text-sm leading-6 text-muted-foreground [animation-delay:220ms]">
          {roleplay
            ? "Build and update twin skills and role plays from your knowledge, set them up, and create personas. Type / for skills, or pick Files to work from."
            : "Build and update your twin’s skills from your knowledge, and set your twin up. Type / for skills, or pick Files to work from."}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-x-10 gap-y-1 sm:grid-cols-2" aria-label="Ways to start">
        {homeStarters({ roleplay }).map((starter, index) => (
          <li key={starter.text} className="animate-copilot-chip [animation-delay:calc(260ms+var(--i)*50ms)]" style={{ "--i": index } as CSSProperties}>
            <button
              type="button"
              onClick={() => onStart(starter.text)}
              className="group/start -mx-2 flex w-[calc(100%+1rem)] flex-col gap-0.5 rounded-tt-sm px-2 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-1.5 text-body text-(--text-secondary) transition-colors duration-150 group-hover/start:text-foreground">
                {starter.text}
                <ArrowRight
                  aria-hidden
                  className="size-3.5 -translate-x-1 text-brand opacity-0 transition-[opacity,translate] duration-200 ease-(--ease-studio) group-hover/start:translate-x-0 group-hover/start:opacity-100 group-focus-visible/start:translate-x-0 group-focus-visible/start:opacity-100"
                />
              </span>
              <span className="text-xs text-muted-foreground">{starter.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatMessage({
  message,
  respond,
  busy,
}: {
  message: EveMessage;
  respond: Respond;
  busy: boolean;
}) {
  // Files sit above the bubble: attached uploads, and the knowledge-base documents picked with Files.
  const files = message.parts.flatMap((part, index) => {
    if (part.type === "file") {
      const { name, url } = copilotUploadOf(part.filename);
      return [{ id: `${message.id}-${index}`, name, mediaType: part.mediaType, href: url, previewUrl: part.mediaType.startsWith("image/") && url ? url : undefined }];
    }
    if (part.type === "text" && message.role === "user") {
      return decodeCopilotMessage(part.text).files.map((file) => ({
        id: `${message.id}-kb-${file.id}`,
        name: file.title,
        mediaType: knowledgeMediaType(file.ext),
        href: knowledgeDocUrl(file.id),
        previewUrl: undefined,
      }));
    }
    return [];
  });
  // A message of files only has no bubble.
  const hasBody = message.parts.some((part) =>
    (part.type === "tool" && part.kind !== "control") ||
    (part.type === "text" && (message.role !== "user" || Boolean(decodeCopilotMessage(part.text).text || decodeCopilotMessage(part.text).skill))));
  return (
    <Message from={message.role}>
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2 group-[.is-assistant]:justify-start">
          {files.map((file) => (
            <MessageFileCard key={file.id} name={file.name} mediaType={file.mediaType} href={file.href} previewUrl={file.previewUrl} />
          ))}
        </div>
      )}
      {hasBody && (
      <MessageContent>
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
            ) : (
              <UserText key={index} raw={part.text} />
            );
          }
          if (part.type === "tool") {
            // Task controls (eve__task_*) are eve's bookkeeping, not the trainer's.
            if (part.name === "todo" || part.kind === "control") return null;
            return (
              <ToolPartView
                key={part.callId}
                part={part}
                respond={respond}
                busy={busy}
              />
            );
          }
          return null;
        })}
      </MessageContent>
      )}
    </Message>
  );
}

/**
 * What a card asks, as the copilot's tools write it (copilot/agent/lib/changes.ts): a sentence, then one
 * `field → value` line per change. The changes become rows, so a trainer reads what changes, not a run-on line.
 */
function ApprovalPrompt({ prompt }: { prompt: string }) {
  const [head, ...rest] = prompt.split("\n");
  const rows = rest.map((line) => {
    const at = line.indexOf(" → ");
    if (at < 0) return { field: "", value: line, suggested: false };
    const value = line.slice(at + 3);
    const suggested = value.endsWith(" (suggested)");
    return { field: line.slice(0, at), value: suggested ? value.slice(0, -" (suggested)".length) : value, suggested };
  }).filter((row) => row.value.trim());
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{head.replace(/:\s*$/, "")}</p>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2">
          {rows.map((row, index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground first-letter:uppercase">{row.field}</dt>
              <dd className="min-w-0 break-words">
                {row.value}
                {row.suggested && <span className="ml-1.5 text-xs text-muted-foreground">suggested</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ToolPartView({
  part,
  respond,
  busy,
}: {
  part: EveToolPart;
  respond: Respond;
  busy: boolean;
}) {
  const interaction = part.interaction?.status === "open" ? part.interaction : undefined;
  const request = interaction?.request;
  const [answer, setAnswer] = useState("");
  // One answer per card: the buttons lock once clicked, until the copilot moves on.
  const [answered, setAnswered] = useState(false);
  const reply = (response: Parameters<Respond>[0]) => {
    setAnswered(true);
    void respond(response).catch(() => setAnswered(false));
  };
  const title = toolTitle(part);

  if (interaction && request) {
    return (
      <Confirmation approval={{ id: interaction.interactionId }} state="approval-requested">
        <ConfirmationTitle>
          {request.kind === "approval"
            ? "Approve this change"
            : "One decision needed"}
        </ConfirmationTitle>
        <ConfirmationRequest>
          <ApprovalPrompt prompt={request.prompt} />
          {request.options && (
            <ConfirmationActions>
              {request.options.map((option) => (
                <ConfirmationAction
                  key={option.id}
                  // eve's approval card leaves its options unstyled: Approve is the action the card is for.
                  variant={option.style === "primary" || (request.kind === "approval" && option.id === "approve") ? "default" : "secondary"}
                  disabled={busy || answered}
                  onClick={() =>
                    reply([{ interactionId: interaction.interactionId, optionId: option.id }])
                  }
                >
                  {request.kind === "approval" && option.id === "deny" ? "Decline" : option.label}
                </ConfirmationAction>
              ))}
            </ConfirmationActions>
          )}
          {request.allowFreeform && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (answer.trim())
                  reply([{ interactionId: interaction.interactionId, text: answer.trim() }]);
              }}
            >
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                aria-label="Your answer"
                className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <Button type="submit" disabled={!answer.trim() || busy || answered}>
                Answer
              </Button>
            </form>
          )}
        </ConfirmationRequest>
      </Confirmation>
    );
  }

  return (
    <div
      className="flex min-h-7 items-center gap-2 py-1 text-sm"
      title={part.state === "failed" ? part.error?.message : undefined}
    >
      <ToolStateIcon state={part.state} />
      <span className={cn("truncate", isRunning(part.state) ? "animate-copilot-shimmer" : "text-muted-foreground")}>
        {part.state === "failed"
          ? `Couldn't ${title.charAt(0).toLowerCase()}${title.slice(1)}`
          : part.state === "rejected"
            ? `Declined: ${title.charAt(0).toLowerCase()}${title.slice(1)}`
            : part.state === "cancelled"
              ? `Stopped: ${title.charAt(0).toLowerCase()}${title.slice(1)}`
          : part.state === "approval" || part.state === "blocked"
            ? `${title}: waiting for you`
            : toolPhrase(title, part.state === "completed" ? "done" : "doing")}
      </span>
      {part.state === "failed" && part.error?.message && (
        <span className="min-w-0 truncate text-xs text-destructive">{part.error.message}</span>
      )}
    </div>
  );
}

function ToolStateIcon({ state }: { state: EveToolPart["state"] }) {
  if (state === "streaming" || state === "requested" || state === "running") {
    return <CircularLoader size="sm" className="shrink-0" />;
  }
  if (state === "completed") {
    return (
      <Check
        className="size-4 shrink-0 text-muted-foreground"
        aria-label="Completed"
      />
    );
  }
  // Your "no" (or Stop) isn't an error: a quiet mark, not a red one.
  if (state === "rejected" || state === "cancelled") {
    return <CircleSlash className="size-4 shrink-0 text-muted-foreground" aria-label={state === "rejected" ? "Declined" : "Stopped"} />;
  }
  if (state === "approval" || state === "blocked") {
    return <CircleAlert className="size-4 shrink-0 text-caution" aria-label="Waiting for you" />;
  }
  return <CircleAlert className="size-4 shrink-0 text-destructive" aria-label="Tool error" />;
}

function WorkspacePanel({
  todos,
  busy,
}: {
  todos: TodoItem[];
  busy: boolean;
}) {
  const items = todos;

  return (
    <div className="flex min-h-0 flex-col gap-3 p-1 sm:p-3">
      {items.length > 0 && (
        <WorkspaceCard icon={ListTodo} title="Todo">
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => {
              const completed = item.status === "completed";
              const working = item.status === "in_progress" && busy;
              const Icon = completed
                ? Check
                : working
                  ? LoaderCircle
                  : item.status === "cancelled"
                    ? CircleAlert
                    : Circle;
              return (
                <li
                  key={`${item.content}-${index}`}
                  className="flex gap-2 rounded-lg px-2 py-2 text-sm hover:bg-sidebar-accent"
                >
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${working ? "animate-spin text-brand" : completed ? "text-foreground" : "text-muted-foreground"}`}
                    aria-label={
                      completed
                        ? "Completed"
                        : working
                          ? "In progress"
                          : item.status === "cancelled"
                            ? "Cancelled"
                            : "Pending"
                    }
                  />
                  <span
                    className={
                      completed
                        ? "text-muted-foreground line-through"
                        : "text-sidebar-foreground"
                    }
                  >
                    {item.content}
                  </span>
                </li>
              );
            })}
          </ul>
        </WorkspaceCard>
      )}

    </div>
  );
}

function WorkspaceCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof ListTodo;
  title: string;
  children: React.ReactNode;
}) {
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
        <ChevronDown
          className="ml-auto size-3.5 transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t px-1 py-1.5">{children}</div>
    </details>
  );
}

/** While the copilot works: what it's doing in its own words ("Reading knowledge"), with light passing over them. */
function Working({ activity }: { activity: string }) {
  return (
    <Message from="assistant">
      <MessageContent>
        <p role="status" className="text-sm">
          {/* A new activity settles in; the words themselves carry the shimmer. */}
          <span key={activity} className="animate-copilot-chip inline-block">
            <span className="animate-copilot-shimmer">{activity}…</span>
          </span>
        </p>
      </MessageContent>
    </Message>
  );
}

function findTodos(messages: readonly EveMessage[]): TodoItem[] {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (part.type !== "tool" || part.name !== "todo") continue;
      const value = part.state === "completed" ? part.output : part.input;
      if (
        !value ||
        typeof value !== "object" ||
        !("todos" in value) ||
        !Array.isArray(value.todos)
      )
        return [];
      return value.todos.filter((item): item is TodoItem => {
        if (!item || typeof item !== "object") return false;
        const todo = item as Record<string, unknown>;
        return (
          typeof todo.content === "string" &&
          ["high", "medium", "low"].includes(String(todo.priority)) &&
          ["pending", "in_progress", "completed", "cancelled"].includes(
            String(todo.status),
          )
        );
      });
    }
  }
  return [];
}

/** A trainer's message: the skill and files they picked as chips, then what they typed. */
/** A trainer's message: the skill chip and their words (picked knowledge files show as cards above the bubble). */
function UserText({ raw }: { raw: string }) {
  const { page, skill, text } = decodeCopilotMessage(raw);
  return (
    <div className="flex flex-col gap-2">
      {page && (
        <Link
          href={page.path as Route}
          className="w-fit max-w-full truncate text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
        >
          On {page.title}
        </Link>
      )}
      {skill && <CopilotChips skill={skill} files={[]} />}
      {text && <p className="whitespace-pre-wrap">{text}</p>}
    </div>
  );
}
