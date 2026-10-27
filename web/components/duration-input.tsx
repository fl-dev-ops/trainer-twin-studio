"use client";

import { Minus, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 10_000;

/** A whole number of minutes in range, or null. */
export function parseMinutes(value: string): number | null {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES ? n : null;
}

/** One − / + press: lands on a multiple of `step` (28 → 30 → 35, 28 → 25), never outside the range. */
export function stepMinutes(current: number | null, delta: number, step = 5): number {
  const base = current ?? (delta > 0 ? 0 : MIN_MINUTES);
  const next = delta > 0 ? Math.floor(base / step) * step + step : Math.ceil(base / step) * step - step;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, next));
}

/**
 * Minutes field (ui/input): − / + step by 5 within range, a "min" suffix, and an invalid state for anything outside it.
 * Controlled as text so a half-typed value is not snapped away; read it with parseMinutes.
 */
export function DurationInput({ id, value, onChange, step = 5, className, "aria-label": ariaLabel }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  step?: number;
  className?: string;
  "aria-label"?: string;
}) {
  const current = parseMinutes(value);
  const nudge = (delta: number) => onChange(String(stepMinutes(current, delta, step)));
  const button = "grid size-8 shrink-0 place-items-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 dark:bg-input/30";
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <button type="button" className={button} aria-label="Fewer minutes" disabled={current !== null && current <= MIN_MINUTES} onClick={() => nudge(-step)}>
        <Minus className="size-3.5" />
      </button>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          step={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={ariaLabel}
          aria-invalid={current === null}
          className="w-24 pr-10 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">min</span>
      </div>
      <button type="button" className={button} aria-label="More minutes" disabled={current !== null && current >= MAX_MINUTES} onClick={() => nudge(step)}>
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
