"use client";

import { useCallback, useEffect, useState } from "react";
import { History, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { SpecType } from "@/lib/specs";

type VersionInfo = { version: number; createdAt: string; label: string };

const LABELS: Record<SpecType, { single: string; title: string; hint: string }> = {
  personas: { single: "persona", title: "Personas", hint: "The trainer voice: style, decision preferences, example phrasings." },
  agents: { single: "agent", title: "Agents", hint: "Interview structure: phases, evidence lanes, claim handling, turn budgets." },
  domains: { single: "domain", title: "Domains", hint: "Domain principles and answer classifications used by the analyzer." },
};

export function SpecManager({ type }: { type: SpecType }) {
  const [specs, setSpecs] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<number>(1);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/spec/${type}`);
    const data = await res.json();
    setSpecs(data.specs ?? []);
    return (data.specs ?? []) as string[];
  }, [type]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, state updates asynchronously
    void loadList();
  }, [loadList]);

  async function open(id: string) {
    const res = await fetch(`/api/spec/${type}/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setSelected(id);
    setText(data.text);
    setCurrentVersion(data.version ?? 1);
    setVersions(data.versions ?? []);
    setDirty(false);
  }

  async function save() {
    if (!selected || saving) return;
    setSaving(true);
    const res = await fetch(`/api/spec/${type}/${selected}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(data.error ?? "Save failed");
      return;
    }
    if (data.versionBumped) {
      toast.success(`Saved as v${data.version} — previous version snapshotted`);
    } else if (data.created) {
      toast.success("Created");
    } else {
      toast.info("No changes to save");
    }
    setDirty(false);
    await loadList();
    await open(selected);
  }

  async function createNew() {
    const id = prompt(`New ${LABELS[type].single} id (e.g. my-${type.slice(0, -1)}):`);
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return;
    const key = type === "personas" ? "persona" : type === "agents" ? "agent" : "domain";
    let domainLine = "";
    if (type === "agents") {
      const response = await fetch("/api/spec/domains");
      const domains = ((await response.json()).specs ?? []) as string[];
      if (domains.length === 0) {
        toast.error("Create a domain before creating an agent");
        return;
      }
      const domain = prompt(`Domain id (${domains.join(", ")}):`, domains[0]);
      if (!domain) return;
      domainLine = `  domain: ${domain}\n`;
    }
    const scaffold = `schema_version: 1\nkind: ${key}\n\n${key}:\n  id: ${id}\n  name: ${LABELS[type].single} ${id}\n  version: 1\n${domainLine}`;
    const res = await fetch(`/api/spec/${type}/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: scaffold }),
    });
    if (!res.ok) {
      const data = await res.json();
      toast.error(data.error ?? "Create failed");
      return;
    }
    toast.success(`Created ${id}`);
    await loadList();
    open(id);
  }

  async function remove() {
    if (!selected || !confirm(`Delete ${selected}? Its version history is removed too.`)) return;
    await fetch(`/api/spec/${type}/${selected}`, { method: "DELETE" });
    toast.success(`Deleted ${selected}`);
    setSelected(null);
    setText("");
    await loadList();
  }

  async function restore(version: number) {
    const res = await fetch(`/api/version/${type}/${selected}?v=${version}`);
    if (!res.ok) return;
    const data = await res.json();
    setText(data.text);
    setDirty(true);
    toast.info(`Loaded v${version} into the editor — save to make it current`);
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 gap-6 overflow-hidden p-6">
      <aside className="flex w-56 shrink-0 flex-col gap-2">
        <Button variant="outline" size="sm" onClick={createNew} className="justify-start">
          <Plus data-icon="inline-start" /> New {LABELS[type].single}
        </Button>
        <div className="flex-1 overflow-y-auto">
          <nav className="flex flex-col gap-1">
            {specs.map((id) => (
              <button
                key={id}
                onClick={() => open(id)}
                className={`w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm ${
                  selected === id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                {id}
              </button>
            ))}
            {specs.length === 0 && (
              <p className="px-2 py-4 text-sm text-muted-foreground">No {type} yet.</p>
            )}
          </nav>
        </div>
        <p className="text-xs text-muted-foreground">{LABELS[type].hint}</p>
      </aside>

      {selected ? (
        <Card className="flex min-w-0 flex-1 flex-col">
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <div className="min-w-0">
              <CardTitle className="truncate">{selected}</CardTitle>
              <CardDescription className="flex items-center gap-2">
                <Badge variant="secondary">v{currentVersion}</Badge>
                {dirty && <span className="text-xs">unsaved changes</span>}
              </CardDescription>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={versions.length === 0} />}>
                  <History data-icon="inline-start" /> History
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>Previous versions</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {versions.map((v) => (
                      <DropdownMenuItem key={v.version} onClick={() => restore(v.version)}>
                        <RotateCcw /> {v.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" size="sm" onClick={remove}>
                <Trash2 data-icon="inline-start" /> Delete
              </Button>
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                Save
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="h-full min-h-0 w-full resize-none rounded-lg border bg-background p-4 font-mono text-xs leading-relaxed"
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="flex min-w-0 flex-1 items-center justify-center">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>Select a {LABELS[type].single}</EmptyTitle>
              <EmptyDescription>
                Pick one from the list, or create a new one. Every changed save snapshots the
                previous version automatically.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Card>
      )}
    </div>
  );
}
