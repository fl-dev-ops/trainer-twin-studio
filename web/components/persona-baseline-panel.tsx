import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { PersonaBaseline } from "@/lib/persona-baseline";

function prettyLabel(value: string) {
  return value.replace(/_/g, " ");
}

function Spectrum({
  label,
  value,
  max,
  display,
  low,
  high,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
  low: string;
  high: string;
}) {
  const position = Math.max(0, Math.min(100, (value / max) * 100));

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs leading-5 text-muted-foreground">{label}</span>
        <span className="shrink-0 text-lg font-semibold tracking-tight tabular-nums">{display}</span>
      </div>
      <div
        className="relative mt-3 h-3"
        role="meter"
        aria-label={`${label}: ${display}`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-sm ring-1 ring-primary/20"
          style={{ left: `${position}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

function Chips({ items, max = 12 }: { items: string[]; max?: number }) {
  if (!items.length) return <span className="text-xs text-muted-foreground">None captured</span>;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;

  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((item) => (
        <span
          key={item}
          className="max-w-full truncate rounded-full border bg-background px-2.5 py-1 text-xs"
          title={item}
        >
          {item}
        </span>
      ))}
      {rest > 0 && <span className="px-1 py-1 text-xs text-muted-foreground">+{rest} more</span>}
    </div>
  );
}

function SectionHeading({ title, tag }: { title: string; tag: "enforced" | "extracted" }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <Badge variant={tag === "enforced" ? "secondary" : "outline"} className="text-[10px]">
        {tag === "enforced" ? "Measured at runtime" : "Extracted from sources"}
      </Badge>
    </div>
  );
}

function SnapshotStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="border-l pl-3 first:border-l-0 first:pl-0 sm:first:border-l sm:first:pl-3">
      <p className="text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

export function PersonaBaselinePanel({ baseline }: { baseline: PersonaBaseline }) {
  const { fingerprint, language, style, decisionPolicy, calibration, provenance } = baseline;
  const pct = (rate: number) => `${Math.round(rate * 100)}%`;
  const hasCalibration = Object.values(calibration).some((value) => value != null);

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-muted/30 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <p className="text-[11px] font-semibold tracking-[0.18em] text-primary uppercase">
                Fidelity reference
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">
                {baseline.name} baseline
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                The reference behavior profile future twin sessions will be compared against.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Version {baseline.version}</Badge>
              {provenance.confidence && (
                <Badge variant="outline" className="capitalize">
                  {provenance.confidence} confidence
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-5 sm:grid-cols-4 sm:p-6">
          <SnapshotStat value={provenance.sourceCount ?? "N/A"} label="Source recordings" />
          <SnapshotStat value={provenance.episodeCount ?? "N/A"} label="Spoken moments" />
          <SnapshotStat value={decisionPolicy.length} label="Decision states" />
          <SnapshotStat
            value={provenance.extractionDate?.slice(0, 10) ?? "N/A"}
            label="Baseline date"
          />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Voice signature</CardTitle>
          <CardDescription>
            Position markers are reference values, not performance scores. A future twin can be plotted on the same scales.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-3">
            <SectionHeading title="Measured speaking pattern" tag="enforced" />
            {fingerprint ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Spectrum
                  label="Double acknowledgement"
                  value={fingerprint.doubled_acknowledgement_rate}
                  max={1}
                  display={pct(fingerprint.doubled_acknowledgement_rate)}
                  low="Never"
                  high="Every turn"
                />
                <Spectrum
                  label="Uses learner's name"
                  value={fingerprint.learner_name_use_rate}
                  max={1}
                  display={pct(fingerprint.learner_name_use_rate)}
                  low="Never"
                  high="Every turn"
                />
                <Spectrum
                  label="Starts with thanks"
                  value={fingerprint.thanks_turn_start_rate}
                  max={1}
                  display={pct(fingerprint.thanks_turn_start_rate)}
                  low="Never"
                  high="Every turn"
                />
                <Spectrum
                  label="Spoken length"
                  value={fingerprint.average_spoken_words}
                  max={40}
                  display={`${fingerprint.average_spoken_words.toFixed(0)} words`}
                  low="0"
                  high="40+ words"
                />
                <Spectrum
                  label="Questions asked"
                  value={fingerprint.average_questions}
                  max={3}
                  display={fingerprint.average_questions.toFixed(1)}
                  low="0"
                  high="3+ per turn"
                />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                Voice index not available yet. Reindex the persona sources to compute this fingerprint.
              </div>
            )}
          </section>

          <Separator />

          <section className="space-y-4">
            <SectionHeading title="Language markers" tag="extracted" />
            {style.tone && (
              <blockquote className="border-l-2 border-primary pl-4 text-sm leading-6">
                {style.tone}
              </blockquote>
            )}
            {(language.sentenceLength || language.questionStyle) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {language.sentenceLength && (
                  <div className="rounded-lg bg-muted/40 p-3">
                    <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Cadence</p>
                    <p className="mt-1 text-xs leading-5">{language.sentenceLength}</p>
                  </div>
                )}
                {language.questionStyle && (
                  <div className="rounded-lg bg-muted/40 p-3">
                    <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Question style</p>
                    <p className="mt-1 text-xs leading-5">{language.questionStyle}</p>
                  </div>
                )}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Strong acknowledgements</p>
                <Chips items={language.acknowledgmentsStrong} max={6} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Soft acknowledgements</p>
                <Chips items={language.acknowledgmentsWeak} max={6} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Bridges</p>
                <Chips items={language.bridges} max={8} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Fillers</p>
                <Chips items={language.fillerWords} max={12} />
              </div>
            </div>
          </section>

          {(style.habits.length > 0 || style.avoid.length > 0) && (
            <>
              <Separator />
              <section className="space-y-3">
                <SectionHeading title="Behavioral guardrails" tag="extracted" />
                <div className="grid gap-4 sm:grid-cols-2">
                  {style.habits.length > 0 && (
                    <div className="rounded-lg border p-4">
                      <p className="text-xs font-medium">Characteristic habits</p>
                      <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-5 text-muted-foreground">
                        {style.habits.map((habit) => <li key={habit}>{habit}</li>)}
                      </ul>
                    </div>
                  )}
                  {style.avoid.length > 0 && (
                    <div className="rounded-lg border p-4">
                      <p className="text-xs font-medium">Avoids</p>
                      <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-5 text-muted-foreground">
                        {style.avoid.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decision signature</CardTitle>
          <CardDescription>
            The trainer&apos;s expected response to each learner signal, grounded in source examples.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-3">
            <SectionHeading title="Learner signal to trainer move" tag="enforced" />
            {decisionPolicy.length > 0 ? (
              <div className="overflow-hidden rounded-lg border">
                {decisionPolicy.map((row) => (
                  <div
                    key={row.state}
                    className="grid gap-3 border-t p-4 first:border-t-0 md:grid-cols-[minmax(8rem,0.7fr)_1rem_minmax(10rem,1fr)_minmax(14rem,1.5fr)] md:items-center"
                  >
                    <div>
                      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                        Learner is
                      </p>
                      <p className="mt-1 text-sm font-medium capitalize">{prettyLabel(row.state)}</p>
                    </div>
                    <ArrowRight className="hidden size-4 text-muted-foreground md:block" aria-hidden="true" />
                    <div>
                      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                        Twin should
                      </p>
                      <p className="mt-1 text-sm font-medium capitalize">{prettyLabel(row.move)}</p>
                    </div>
                    <div className="rounded-md bg-muted/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Evidence</p>
                        <Badge variant="outline" className="text-[10px] tabular-nums">
                          {row.exampleCount} {row.exampleCount === 1 ? "example" : "examples"}
                        </Badge>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground" title={row.sample ?? undefined}>
                        {row.sample ? `"${row.sample}"` : "No source example captured"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                No decision policy has been extracted yet.
              </div>
            )}
          </section>

          {hasCalibration && (
            <>
              <Separator />
              <section className="space-y-3">
                <SectionHeading title="Response calibration" tag="extracted" />
                <div className="grid gap-3 sm:grid-cols-3">
                  {calibration.firmness_on_weak_answer != null && (
                    <Spectrum
                      label="On a weak answer"
                      value={calibration.firmness_on_weak_answer}
                      max={1}
                      display={pct(calibration.firmness_on_weak_answer)}
                      low="Gentle"
                      high="Firm"
                    />
                  )}
                  {calibration.patience_with_confusion != null && (
                    <Spectrum
                      label="With confusion"
                      value={calibration.patience_with_confusion}
                      max={1}
                      display={pct(calibration.patience_with_confusion)}
                      low="Brief"
                      high="Patient"
                    />
                  )}
                  {calibration.warmth_on_strong_answer != null && (
                    <Spectrum
                      label="On a strong answer"
                      value={calibration.warmth_on_strong_answer}
                      max={1}
                      display={pct(calibration.warmth_on_strong_answer)}
                      low="Reserved"
                      high="Warm"
                    />
                  )}
                </div>
                {calibration.preamble_before_question && (
                  <p className="text-xs text-muted-foreground">
                    Question preamble: <span className="font-medium text-foreground">{calibration.preamble_before_question}</span>
                  </p>
                )}
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
