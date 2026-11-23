"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageSection, SECTION_CARD } from "@/components/page-section";
import { SwitchToggle } from "@/components/switch-toggle";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useRefresh } from "@/lib/use-refresh";
import { cn } from "@/lib/utils";

type Attached = { id: string; name: string; active: boolean };
type Choice = { id: string; name: string; items: number };

/**
 * An agent's supporting skills (specs/agents.md): the topic skills it draws on after its main skill, in order, each
 * switchable. A draft saved from its bar; calls in progress keep the skills they started with.
 */
export function SupportingSkillsEditor({ title, description, empty, attached, choices, onSave }: {
  title: string;
  description: string;
  /** Shown when nothing is attached. */
  empty: string;
  attached: Attached[];
  choices: Choice[];
  onSave: (skills: { skillId: string; active: boolean }[]) => Promise<unknown>;
}) {
  const refresh = useRefresh();
  const initial = () => attached.map((skill) => ({ skillId: skill.id, active: skill.active }));
  const [draft, setDraft] = useState(initial);
  const [received, setReceived] = useState(attached);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial());
  if (received !== attached) {
    setReceived(attached);
    if (!dirty) setDraft(initial());
  }
  const names = new Map([...choices, ...attached].map((skill) => [skill.id, skill.name]));
  const taken = new Set(draft.map((skill) => skill.skillId));
  const move = (index: number, by: number) => setDraft((prev) => {
    const next = [...prev];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    return next;
  });
  async function save() {
    setBusy(true);
    try {
      await onSave(draft);
      toast.success("Skills saved");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the skills");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageSection title={title} description={description}>
      <div className={cn(SECTION_CARD, "flex min-w-0 flex-col gap-3 overflow-hidden px-5 py-4")}>
        {draft.length ? (
          <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label={title}>
            {draft.map((skill, index) => (
              <li key={skill.skillId} className="flex items-center justify-between gap-3 rounded-tt-md border border-(--border) px-3 py-2">
                <span className="min-w-0 truncate text-sm">{index + 1}. {names.get(skill.skillId) ?? skill.skillId}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" disabled={busy || index === 0} aria-label="Move up" onClick={() => move(index, -1)}>↑</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={busy || index === draft.length - 1} aria-label="Move down" onClick={() => move(index, 1)}>↓</Button>
                  <SwitchToggle checked={skill.active} label={`Use ${names.get(skill.skillId) ?? "skill"}`}
                    onChange={(active) => setDraft((prev) => prev.map((row) => row.skillId === skill.skillId ? { ...row, active } : row))} />
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDraft((prev) => prev.filter((row) => row.skillId !== skill.skillId))}>Remove</Button>
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="m-0 text-sm text-muted-foreground">{empty}</p>}
        {choices.some((skill) => !taken.has(skill.id)) ? (
          <NativeSelect aria-label="Add a skill" value="" disabled={busy} onChange={(event) => {
            if (event.target.value) setDraft((prev) => [...prev, { skillId: event.target.value, active: true }]);
          }}>
            <option value="">Add a skill…</option>
            {choices.filter((skill) => !taken.has(skill.id)).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
          </NativeSelect>
        ) : null}
        {dirty ? (
          <div className="flex items-center justify-end gap-2 border-t border-(--border) pt-3">
            <span className="mr-auto text-sm text-muted-foreground" role="status">Unsaved changes</span>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(initial())}>Discard</Button>
            <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        ) : null}
      </div>
    </PageSection>
  );
}
