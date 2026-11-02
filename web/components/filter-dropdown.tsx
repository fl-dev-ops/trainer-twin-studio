"use client";

import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type FilterOption = { value: string; label: string };

/** A filter pill (date range, agent, learner): shows the current option and opens a menu with the choice checked. */
export function FilterDropdown({
  value,
  onChange,
  options,
  align = "start",
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  align?: "start" | "end";
}) {
  const current = options.find((option) => option.value === value)?.label ?? options[0]?.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        <span>{current}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-44">
        <DropdownMenuGroup>
          {options.map((option) => (
            <DropdownMenuItem key={option.value} onClick={() => onChange(option.value)} className="justify-between">
              <span>{option.label}</span>
              {option.value === value ? <Check className="size-3.5 text-brand" aria-hidden /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The date ranges the twin pages filter by, and whether an ISO time falls in one ("30", "7", "today", "all"). */
export const DATE_RANGES: FilterOption[] = [
  { value: "30", label: "Last 30 days" },
  { value: "7", label: "Last 7 days" },
  { value: "today", label: "Today" },
  { value: "all", label: "All time" },
];

const DAY = 86_400_000;

export function inDateRange(iso: string, range: string, now = Date.now()) {
  if (range === "all") return true;
  const at = new Date(iso).getTime();
  if (range === "today") return new Date(at).toDateString() === new Date(now).toDateString();
  return at >= now - Number(range) * DAY;
}
