"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

type Topic = TwinOutputs["dosDonts"]["list"][number];
type Rule = Topic["dos"][number];
type Kind = "do" | "dont";

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : "That wasn't saved. Try again.");

/**
 * Do's & Don'ts (the Configure tab): per topic, the main rules from the twin's playbooks in the coach's own words,
 * picked once and then fixed; she edits, adds or removes lines. Saved as she goes; the twin keeps following its
 * playbooks until changes are applied (later).
 */
export function TwinDosDonts({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const key = ["twin.dosDonts", slug];
  const list = useQuery({ queryKey: key, queryFn: () => twinClient.dosDonts.list.query({ slug }), staleTime: Infinity });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  if (list.isPending) {
    return (
      <p className="m-0 flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading your playbooks…
      </p>
    );
  }
  if (list.isError) {
    return (
      <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
        Couldn&apos;t load your Do&apos;s &amp; Don&apos;ts.
        <Button size="sm" variant="secondary" onClick={() => void list.refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-muted-foreground">Frequent patterns observed in your videos, posts and course.</p>
      {list.data.length === 0 ? (
        <p className="m-0 py-6 text-sm text-muted-foreground">No playbooks yet: Do&apos;s &amp; Don&apos;ts come from your twin&apos;s skills.</p>
      ) : null}
      {list.data.map((topic) => (
        <article key={topic.skillAgentId} className="flex flex-col gap-4 rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
          <h3 className="m-0 text-sm font-semibold">{topic.name}</h3>
          <RuleList slug={slug} topic={topic} kind="do" rules={topic.dos} onChanged={refresh} />
          <RuleList slug={slug} topic={topic} kind="dont" rules={topic.donts} onChanged={refresh} />
        </article>
      ))}
    </div>
  );
}

/** One kind's lines in a topic, with "+ Add". */
function RuleList({ slug, topic, kind, rules, onChanged }: { slug: string; topic: Topic; kind: Kind; rules: Rule[]; onChanged: () => void }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const label = kind === "do" ? "Do" : "Don't";

  const add = async () => {
    const text = adding?.trim();
    if (!text) return;
    setSaving(true);
    try {
      await twinClient.dosDonts.add.mutate({ slug, skillAgentId: topic.skillAgentId, kind, text });
      setAdding(null);
      onChanged();
    } catch (error) {
      toast.error(message(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <p className={cn("m-0 text-xs font-semibold tracking-wide uppercase", kind === "do" ? "text-success" : "text-caution")}>
        {kind === "do" ? "✓ Do" : "✕ Don't"}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rules.map((rule) => <RuleLine key={rule.id} rule={rule} onChanged={onChanged} />)}
      </ul>
      {adding === null ? (
        <button type="button" onClick={() => setAdding("")} className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground underline-offset-2 hover:underline">
          <Plus className="size-3.5" aria-hidden /> Add a {label}
        </button>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            autoFocus
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            placeholder={kind === "do" ? "I always…" : "I never…"}
            aria-label={`New ${label}`}
            className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
          <Button type="submit" size="sm" variant="strong" disabled={saving || !adding.trim()}>Add</Button>
        </form>
      )}
    </section>
  );
}

/** One line: its words, its tags (Edited, Added, a team member's suggestion), and edit / remove. */
function RuleLine({ rule, onChanged }: { rule: Rule; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const text = editing?.trim();
    if (!text) return;
    setSaving(true);
    try {
      await twinClient.dosDonts.edit.mutate({ id: rule.id, text });
      setEditing(null);
      onChanged();
    } catch (error) {
      toast.error(message(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await twinClient.dosDonts.remove.mutate({ id: rule.id });
      onChanged();
      toast("Removed", {
        action: {
          label: "Undo",
          onClick: () => void twinClient.dosDonts.remove.mutate({ id: rule.id, restore: true }).then(onChanged, (error: unknown) => toast.error(message(error))),
        },
      });
    } catch (error) {
      toast.error(message(error));
    }
  };

  if (editing !== null) {
    return (
      <li>
        <form
          className="flex items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            aria-label="Edit this rule"
            className="min-w-0 flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button type="submit" size="sm" variant="strong" disabled={saving || !editing.trim()}>
            <Check className="size-3.5" /> Save
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm">{rule.text}</span>
        {rule.source !== "playbook" || rule.suggestion || (rule.originalText && rule.originalText !== rule.text) ? (
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {rule.source === "edited" ? <span>Edited{rule.editedBy ? ` by ${rule.editedBy}` : ""}</span> : null}
            {rule.source === "added" ? <span>Added{rule.editedBy ? ` by ${rule.editedBy}` : ""}</span> : null}
            {rule.suggestion ? <span>· Team suggestion</span> : null}
            {rule.originalText && rule.originalText !== rule.text ? (
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => setShowOriginal((open) => !open)}>
                {showOriginal ? "Hide from playbook" : "From your playbook"}
              </button>
            ) : null}
          </span>
        ) : null}
        {showOriginal && rule.originalText ? <span className="text-xs text-muted-foreground italic">Playbook: {rule.originalText}</span> : null}
      </div>
      <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(rule.text)}>
        <Pencil />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => void remove()}>
        <X />
      </Button>
    </li>
  );
}
