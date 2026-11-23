"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, History, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PersonaBaselinePanel } from "@/components/persona-baseline-panel";
import type { PersonaBaseline } from "@/lib/persona-baseline";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { PersonaSourcePanel } from "@/components/persona-source-panel";
import { useRefresh } from "@/lib/use-refresh";
import { dashRoute } from "@/lib/routes";

type VersionInfo = { version: number; createdAt: string; label: string };

const COPY = {
  single: "persona",
  title: "Personas",
  description: "Reusable behavior, communication style, and decision preferences.",
} as const;

/** A persona's spec page: sources, recorded baseline and the advanced YAML. */
export function SpecResourceEditor({
  type,
  slug,
  name,
  text: initialText,
  currentVersion,
  shownVersion,
  versions,
  sources = [],
  baseline = null,
}: {
  type: "personas";
  slug: string;
  name: string;
  text: string;
  currentVersion: number;
  shownVersion: number;
  versions: VersionInfo[];
  sources?: { id: string; kind: string; name: string; status: string; metadata?: unknown; createdAt: Date }[];
  baseline?: PersonaBaseline | null;
}) {
  const router = useRouter();
  const refresh = useRefresh();
  const [text, setText] = useState(initialText);
  // Chosen once: a refetch that brings a baseline must not change an uncontrolled Tabs' default.
  const [initialAsideTab] = useState(baseline ? "baseline" : "sources");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const historical = shownVersion !== currentVersion;
  const basePath = dashRoute(`/${type}/${encodeURIComponent(slug)}`);
  const editPath = basePath;
  const copy = COPY;

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
    refresh();
  }

  async function remove() {
    if (!confirm(`Delete ${slug}? Its version history will also be removed.`)) return;
    const response = await fetch(`/api/spec/${type}/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: string } | null;
      return toast.error(response.status === 409 && result?.error ? result.error : `Could not delete ${slug}`);
    }
    toast.success(`Deleted ${slug}`);
    router.push(dashRoute(`/${type}`));
    refresh();
  }

  async function restore() {
    if (!confirm(`Restore v${shownVersion} as the current ${copy.single}? The current version will remain in history.`)) return;
    await save(initialText);
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon-sm" render={<Link href={dashRoute(`/${type}`)} />} nativeButton={false} aria-label={`Back to ${copy.title}`}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">
              {name}
            </h1>
            <Badge variant={historical ? "outline" : "secondary"}>{historical ? `History v${shownVersion}` : `Current v${currentVersion}`}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{slug}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
                <DropdownMenuItem key={version.version} onClick={() => router.push(dashRoute(`/${type}/${encodeURIComponent(slug)}?version=${version.version}`))}>
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
            {dirty && (
              <Button
                size="sm"
                onClick={() => save()}
                disabled={!dirty || saving}
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

      {(
        <Tabs defaultValue={initialAsideTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b px-4 py-2 sm:px-6">
            <TabsList>
              {baseline && <TabsTrigger value="baseline">Baseline</TabsTrigger>}
              <TabsTrigger value="sources">Sources</TabsTrigger>
            </TabsList>
          </div>

          {baseline && (
            <TabsContent value="baseline" className="mt-0 min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <div className="mx-auto max-w-4xl">
                <PersonaBaselinePanel baseline={baseline} />
              </div>
            </TabsContent>
          )}

          <TabsContent value="sources" className="mt-0 min-h-0 flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(19.8rem,3fr)] lg:overflow-hidden">
              <PersonaSourcePanel
                personaSlug={slug}
                initialSources={sources}
                disabled={historical}
              />
              <section className="order-2 min-w-0 border-t bg-muted/20 p-4 sm:p-6 lg:overflow-y-auto lg:border-t-0 lg:border-l">
                <h2 className="text-sm font-semibold">Persona model</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Automatically rebuilt after every source in the library finishes indexing.
                </p>
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
                      className="min-h-96 w-full resize-y rounded-lg border bg-background p-3 font-mono text-overline leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted"
                    />
                  </div>
                </details>
              </section>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}
