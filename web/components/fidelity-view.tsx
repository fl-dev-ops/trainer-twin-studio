import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type FidelityReport, type FidelityRun, percentage } from "@/lib/fidelity-report";
import type { PersonaBaseline, VoiceFingerprint } from "@/lib/persona-baseline";

type ScenarioSummary = { slug: string; name: string; version: number };
type DetailSection = "voice" | "language" | "decisions" | "behavior" | "knowledge" | "quality";

function readableLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function aggregateFingerprint(runs: FidelityRun[]): VoiceFingerprint | null {
  const entries = runs.flatMap((run) => run.turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => ({ text: turn.content, learner: run.learner.name })));
  if (!entries.length) return null;
  const doubled = /\b(yes|yeah|correct|right|good|okay|sure|no)[,. ]+\1\b/i;
  const mentionsLearner = ({ text, learner }: (typeof entries)[number]) => {
    const escaped = learner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  };
  return {
    turns: entries.length,
    learner_name_use_rate: entries.filter(mentionsLearner).length / entries.length,
    doubled_acknowledgement_rate: entries.filter(({ text }) => doubled.test(text)).length / entries.length,
    thanks_turn_start_rate: entries.filter(({ text }) => /^(thanks|thank you)\b/i.test(text)).length / entries.length,
    average_spoken_words: entries.reduce((sum, { text }) => sum + text.trim().split(/\s+/).filter(Boolean).length, 0) / entries.length,
    average_questions: entries.reduce((sum, { text }) => sum + (text.match(/\?/g)?.length ?? 0), 0) / entries.length,
  };
}

function Score({ value }: { value: number | null }) {
  return (
    <div className="min-w-24 space-y-1.5">
      <span className="font-medium tabular-nums">{percentage(value)}</span>
      {value != null && <Progress value={value * 100} aria-label={`${Math.round(value * 100)} percent`} />}
    </div>
  );
}

function Comparison({ label, baseline, simulated, format }: {
  label: string;
  baseline: number;
  simulated: number;
  format: (value: number) => string;
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Baseline</p><p className="text-lg font-semibold tabular-nums">{format(baseline)}</p></div>
        <div className="text-right"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Simulation</p><p className="text-lg font-semibold tabular-nums">{format(simulated)}</p></div>
      </div>
    </div>
  );
}

function Marker({ value, observed }: { value: string; observed: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <span className="text-sm leading-5">{value}</span>
      <Badge variant={observed ? "secondary" : "outline"}>{observed ? "Observed" : "Baseline"}</Badge>
    </div>
  );
}

export function FidelityView({
  report,
  scenarios,
  baseline,
  selectedScenario,
  selectedSection,
}: {
  report: FidelityReport;
  scenarios: ScenarioSummary[];
  baseline: PersonaBaseline | null;
  selectedScenario?: string;
  selectedSection?: string;
}) {
  const result = report.scenarios.find((item) => item.slug === selectedScenario) ?? report.scenarios[0];
  const section: DetailSection = ["voice", "language", "decisions", "behavior", "knowledge", "quality"].includes(selectedSection ?? "")
    ? selectedSection as DetailSection
    : "voice";
  const fingerprint = result ? aggregateFingerprint(result.runs) : null;
  const trainerText = result?.runs.flatMap((run) => run.turns)
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join(" ")
    .toLowerCase() ?? "";
  const markers = baseline
    ? [...baseline.language.acknowledgmentsStrong.slice(0, 2), ...baseline.language.bridges.slice(0, 2)]
    : [];
  const observedMarkers = markers.filter((marker) => trainerText.includes(marker.toLowerCase())).length;
  const languageAdherence = markers.length ? observedMarkers / markers.length : null;
  const voiceAdherence = baseline?.fingerprint && fingerprint
    ? Math.max(0, 1 - (
        Math.abs(baseline.fingerprint.learner_name_use_rate - fingerprint.learner_name_use_rate) +
        Math.abs(baseline.fingerprint.doubled_acknowledgement_rate - fingerprint.doubled_acknowledgement_rate) +
        Math.min(1, Math.abs(baseline.fingerprint.average_spoken_words - fingerprint.average_spoken_words) / 40)
      ) / 3)
    : null;
  const searches = result?.runs.flatMap((run) => run.knowledgeSearches) ?? [];
  const retrievals = result?.runs.flatMap((run) => run.knowledgeRetrievals) ?? [];
  const retrievedChunks = retrievals.flatMap((retrieval) => retrieval.output.results.map((chunk) => ({
    ...chunk,
    query: typeof retrieval.input.query === "string" ? retrieval.input.query : undefined,
  })));
  const topics = Array.from(new Set(searches.flatMap((search) => {
    const value = search.input?.topics;
    return Array.isArray(value) ? value.map(String) : [];
  })));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Scenario fidelity</CardTitle>
          <CardDescription>Select a scenario to inspect its consolidated simulation findings.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scenario</TableHead>
                <TableHead>Persona fidelity</TableHead>
                <TableHead>Decision adherence</TableHead>
                <TableHead>Knowledge retrieval</TableHead>
                <TableHead>Session quality</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scenarios.map((scenario) => {
                const item = report.scenarios.find((candidate) => candidate.slug === scenario.slug);
                return (
                  <TableRow key={scenario.slug} data-state={item?.slug === result?.slug ? "selected" : undefined}>
                    <TableCell>
                      {item ? (
                        <Link href={`/agents/fidelity?scenario=${encodeURIComponent(item.slug)}&section=voice`} className="font-medium hover:underline">{scenario.name}</Link>
                      ) : <span className="font-medium">{scenario.name}</span>}
                      <p className="mt-0.5 text-xs text-muted-foreground">Version {scenario.version}{item ? ` · ${item.runs.length}/${item.expectedRuns} simulations` : " · Not run"}</p>
                    </TableCell>
                    <TableCell>{item ? <Score value={item.personaFidelity} /> : "—"}</TableCell>
                    <TableCell>{item ? <Score value={item.decisionAdherence} /> : "—"}</TableCell>
                    <TableCell>{item ? (item.knowledgeTrackedRuns ? `Yes · ${item.knowledgeSearchCount} searches` : "Source ready · trace unavailable") : "Source ready · not run"}</TableCell>
                    <TableCell>{item ? <Score value={item.sessionQuality} /> : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {result && (
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">{result.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Consolidated across {result.runs.length} simulated conversations.</p>
          </div>

          <nav aria-label="Fidelity details" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            {([
              ["voice", "Voice signature", percentage(voiceAdherence)],
              ["language", "Language markers", percentage(languageAdherence)],
              ["decisions", "Decision signature", percentage(result.decisionAdherence)],
              ["behavior", "Behavioral guardrails", percentage(result.personaFidelity)],
              ["knowledge", "Knowledge retrieval", result.knowledgeTrackedRuns ? `${result.knowledgeSearchCount} searches` : "Source ready"],
              ["quality", "Session quality", percentage(result.sessionQuality)],
            ] as const).map(([value, label, metric]) => (
              <Link
                key={value}
                href={`/agents/fidelity?scenario=${encodeURIComponent(result.slug)}&section=${value}`}
                className={section === value ? "rounded-xl border border-primary bg-primary/5 p-3" : "rounded-xl border p-3 transition-colors hover:bg-muted/50"}
              >
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{metric}</p>
              </Link>
            ))}
          </nav>

          {section === "voice" && <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><CardTitle>Voice signature</CardTitle><CardDescription>Measured speaking patterns compared with the persona baseline.</CardDescription></div>
                <Badge variant="secondary">Voice adherence {percentage(voiceAdherence)}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              {baseline?.fingerprint && fingerprint ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <Comparison label="Uses learner's name" baseline={baseline.fingerprint.learner_name_use_rate} simulated={fingerprint.learner_name_use_rate} format={(value) => `${Math.round(value * 100)}%`} />
                  <Comparison label="Double acknowledgement" baseline={baseline.fingerprint.doubled_acknowledgement_rate} simulated={fingerprint.doubled_acknowledgement_rate} format={(value) => `${Math.round(value * 100)}%`} />
                  <Comparison label="Spoken length" baseline={baseline.fingerprint.average_spoken_words} simulated={fingerprint.average_spoken_words} format={(value) => `${value.toFixed(0)} words`} />
                </div>
              ) : <p className="text-sm text-muted-foreground">Voice signature data is not available.</p>}
            </CardContent>
          </Card>}

          {section === "language" && <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><CardTitle>Language markers</CardTitle><CardDescription>Representative baseline phrases found in the simulations.</CardDescription></div>
                  <Badge variant="secondary">Adherence {percentage(languageAdherence)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {markers.map((marker) => <Marker key={marker} value={marker} observed={trainerText.includes(marker.toLowerCase())} />)}
                {!markers.length && <p className="text-sm text-muted-foreground">No language markers available.</p>}
                {baseline?.language.questionStyle && <p className="pt-2 text-sm leading-6 text-muted-foreground">{baseline.language.questionStyle}</p>}
                {!!markers.length && <p className="pt-2 text-xs text-muted-foreground">{observedMarkers} of {markers.length} representative baseline markers were observed across the simulations.</p>}
              </CardContent>
            </Card>}

            {section === "decisions" && <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><CardTitle>Decision signature</CardTitle><CardDescription>How this trainer responds to different learner states.</CardDescription></div>
                  <Badge variant="secondary">Adherence {percentage(result.decisionAdherence)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {baseline?.decisionPolicy.length ? <div className="grid gap-3 md:grid-cols-2">
                  {baseline.decisionPolicy.map((row) => <div key={row.state} className="rounded-lg border bg-background p-3">
                    <p className="text-xs text-muted-foreground">When learner state is</p>
                    <p className="mt-1 text-sm font-medium">{readableLabel(row.state)}</p>
                    <p className="mt-3 text-xs text-muted-foreground">Preferred move</p>
                    <p className="mt-1 text-sm font-medium">{readableLabel(row.move)}</p>
                    {row.sample && <p className="mt-3 text-xs leading-5 text-muted-foreground">“{row.sample}”</p>}
                    <p className="mt-2 text-[10px] text-muted-foreground">{row.exampleCount} source {row.exampleCount === 1 ? "example" : "examples"}</p>
                  </div>)}
                </div> : <p className="text-sm text-muted-foreground">Decision policy data is not available for this persona.</p>}
                {result.decisionCount ? (
                  <div>
                    <div className="flex items-end justify-between gap-4"><span className="text-3xl font-semibold tabular-nums">{percentage(result.decisionAdherence)}</span><span className="text-xs text-muted-foreground">{result.decisionMatches} policy matches across {result.decisionCount} learner turns · {result.decisionEvaluatedCount} decisions evaluated</span></div>
                    <Progress className="mt-3" value={(result.decisionAdherence ?? 0) * 100} aria-label={`Decision adherence ${percentage(result.decisionAdherence)}`} />
                  </div>
                ) : <p className="text-sm text-muted-foreground">This report predates transcript-level decision evaluation. The baseline policy is shown, but adherence cannot be scored.</p>}
              </CardContent>
            </Card>}

            {section === "behavior" && <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div><CardTitle>Behavioral guardrails</CardTitle><CardDescription>Adherence to extracted trainer habits and avoidances.</CardDescription></div>
                  <span className="text-2xl font-semibold tabular-nums">{percentage(result.personaFidelity)}</span>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div><p className="text-xs font-medium">Characteristic habits</p><ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-5 text-muted-foreground">{baseline?.style.habits.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><p className="text-xs font-medium">Avoids</p><ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-5 text-muted-foreground">{baseline?.style.avoid.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul></div>
              </CardContent>
            </Card>}

            {section === "knowledge" && <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div><CardTitle>Knowledge retrieval</CardTitle><CardDescription>Approved source availability and observed retrieval activity.</CardDescription></div>
                  <Badge variant="secondary">Source: Yes</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg bg-muted/40 p-3"><p className="font-medium">Acme Knowledge</p><p className="mt-1 text-xs text-muted-foreground">38 indexed documents</p></div>
                {result.knowledgeTrackedRuns ? (
                  <p className="text-sm">Retrieved in {result.knowledgeRetrievalRuns} of {result.knowledgeTrackedRuns} tracked simulations · {result.knowledgeSearchCount} searches.</p>
                ) : <p className="text-sm text-muted-foreground">This historical run predates retrieval tracing. The approved source was available, but calls were not recorded.</p>}
                {!!topics.length && <div className="flex flex-wrap gap-2">{topics.map((topic) => <Badge key={topic} variant="outline">{topic}</Badge>)}</div>}
                {!!retrievedChunks.length && <div className="space-y-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Retrieved evidence</p>
                  {retrievedChunks.map((chunk, index) => <div key={`${chunk.chunkId}-${index}`} className="rounded-lg border bg-background p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{chunk.title || chunk.source || "Knowledge document"}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{chunk.source || "Unknown source"} · document {chunk.docId}{chunk.chunkIndex != null ? ` · chunk ${chunk.chunkIndex}` : ""}</p>
                      </div>
                      <Badge variant="outline">Relevance {Math.round(chunk.score * 100)}%</Badge>
                    </div>
                    {chunk.query && <p className="mt-3 text-xs text-muted-foreground">Query: {chunk.query}</p>}
                    <p className="mt-2 line-clamp-4 text-sm leading-6">{chunk.text}</p>
                    <p className="mt-2 font-mono text-[10px] text-muted-foreground">{chunk.chunkId}</p>
                  </div>)}
                </div>}
                {!!retrievals.length && !retrievedChunks.length && <p className="text-sm text-muted-foreground">Searches completed without matching evidence.</p>}
                {!!searches.length && !retrievals.length && <p className="text-sm text-muted-foreground">Search calls were recorded, but result-level evidence is unavailable for this report.</p>}
              </CardContent>
            </Card>}

            {section === "quality" && <Card>
              <CardHeader><CardTitle>Session quality</CardTitle><CardDescription>Average of conversation completeness and role adherence.</CardDescription></CardHeader>
              <CardContent>
                <div className="flex items-end justify-between gap-4"><span className="text-3xl font-semibold tabular-nums">{percentage(result.sessionQuality)}</span><span className="text-xs text-muted-foreground">Across {result.runs.length} simulations</span></div>
                <Progress className="mt-4" value={(result.sessionQuality ?? 0) * 100} aria-label={`Session quality ${percentage(result.sessionQuality)}`} />
                <p className="mt-3 text-xs leading-5 text-muted-foreground">Completeness measures whether learner intentions were addressed. Role adherence measures whether the twin stayed in the assigned trainer and scenario role.</p>
              </CardContent>
            </Card>}
        </section>
      )}
    </div>
  );
}
