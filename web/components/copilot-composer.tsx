"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Brain, Check, FileText, FileVideo, Library, MessagesSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COPILOT_SKILLS, type CopilotSkillName, type PickedFile } from "@/lib/copilot-message";
import { cn } from "@/lib/utils";

/** The copilot composer's extras (plans/copilot-v2.md): Files from the knowledge base, the "/" skill menu, chips. */

const VIDEO = new Set(["mp4", "mov", "m4a", "mp3", "wav", "webm"]);

function FileIcon({ ext, className }: { ext?: string; className?: string }) {
  return ext && VIDEO.has(ext.toLowerCase()) ? <FileVideo className={className} aria-hidden="true" /> : <FileText className={className} aria-hidden="true" />;
}

function SkillIcon({ name, className }: { name: CopilotSkillName; className?: string }) {
  return name === "twin-creator" ? <Brain className={className} aria-hidden="true" /> : <MessagesSquare className={className} aria-hidden="true" />;
}

type KnowledgeDoc = { id: string; title: string; ext: string; status: string };

/** Files: pick existing knowledge-base documents to work from. */
export function KnowledgeFilePicker({ selected, onChange, disabled }: { selected: PickedFile[]; onChange: (files: PickedFile[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Refetched on each open: an upload in another tab shows up.
    fetch("/api/knowledge/documents", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: { documents?: KnowledgeDoc[] }) => {
        setDocs((body.documents ?? []).filter((doc) => doc.status !== "failed"));
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [open]);

  const picked = new Set(selected.map((file) => file.id));
  const toggle = (doc: KnowledgeDoc) =>
    onChange(picked.has(doc.id) ? selected.filter((file) => file.id !== doc.id) : [...selected, { id: doc.id, title: doc.title, ext: doc.ext }]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label="Pick files from your knowledge base" />}
      >
        <Library data-icon="inline-start" aria-hidden="true" />
        Files
        {selected.length > 0 && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{selected.length}</span>}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Search knowledge files…" />
          <CommandList className="max-h-72">
            <CommandEmpty>{failed ? "Couldn't load your files." : docs === null ? "Loading…" : "No files found."}</CommandEmpty>
            {docs && docs.length > 0 && (
              <CommandGroup>
                {docs.map((doc) => (
                  <CommandItem key={doc.id} value={`${doc.title} ${doc.id}`} onSelect={() => toggle(doc)}>
                    <FileIcon ext={doc.ext} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                    {picked.has(doc.id) && <Check className="size-4 shrink-0" aria-label="Selected" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <Link href="/twin/knowledge" className="flex items-center gap-2 border-t px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            <Library className="size-4" aria-hidden="true" />
            Browse all
            <ArrowUpRight className="ml-auto size-3.5" aria-hidden="true" />
          </Link>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The "/" menu: the two skills, filtered by what follows the slash. Keyboard handled by the composer. */
export function SkillMenu({ skills, active, onPick, onHover }: {
  skills: readonly (typeof COPILOT_SKILLS)[number][];
  active: number;
  onPick: (name: CopilotSkillName) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div role="listbox" aria-label="Skills" className="pointer-events-auto mb-2 overflow-hidden rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg">
      <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Skills</p>
      {skills.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">No matching skill.</p>
      ) : (
        skills.map((skill, index) => (
            <button
              key={skill.name}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => onHover(index)}
              // Keep focus in the textarea.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(skill.name)}
              className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm", index === active && "bg-accent")}
            >
              <SkillIcon name={skill.name} className="size-4 shrink-0" />
              <span className="font-medium">{skill.label}</span>
              <span className="truncate text-muted-foreground">{skill.description}</span>
            </button>
        ))
      )}
    </div>
  );
}

/** The picked skill and files above the textarea (removable), or under a sent message (read-only). */
export function CopilotChips({ skill, files, onRemoveSkill, onRemoveFile, className }: {
  skill?: CopilotSkillName;
  files: PickedFile[];
  onRemoveSkill?: () => void;
  onRemoveFile?: (id: string) => void;
  className?: string;
}) {
  if (!skill && !files.length) return null;
  const meta = skill ? COPILOT_SKILLS.find((s) => s.name === skill) : undefined;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {meta && (
        <Chip label={meta.label} icon={<SkillIcon name={meta.name} className="size-3.5" />} onRemove={onRemoveSkill} tone="skill" />
      )}
      {files.map((file) => (
        <Chip key={file.id} label={file.title} icon={<FileIcon ext={file.ext} className="size-3.5" />} onRemove={onRemoveFile ? () => onRemoveFile(file.id) : undefined} />
      ))}
    </div>
  );
}

function Chip({ label, icon, onRemove, tone }: { label: string; icon: React.ReactNode; onRemove?: () => void; tone?: "skill" }) {
  return (
    <span className={cn("inline-flex max-w-64 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", tone === "skill" ? "border-brand/40 bg-brand/10 text-foreground" : "bg-muted/60")}>
      {icon}
      <span className="truncate">{label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="-mr-1 rounded-full p-0.5 hover:bg-foreground/10">
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
