"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { SessionsIcon } from "@/components/icons";
import { TwinSessionItem, type TwinSessionItemData } from "@/components/twin/twin-session-item";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const DATE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "7", label: "Last 7 days" },
  { value: "today", label: "Today" },
  { value: "all", label: "All time" },
];

function FilterDropdown({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
}) {
  const currentLabel = options.find((o) => o.value === value)?.label || options[0].label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="inline-flex h-8 items-center justify-between gap-2.5 rounded-full border border-(--border) bg-transparent px-4 text-[13px] font-normal text-(--foreground) transition-colors hover:bg-(--tone-control) outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
          >
            <span>{currentLabel}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-44 rounded-[12px] p-1 bg-card border border-(--card-border) shadow-lg">
        <DropdownMenuGroup>
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => onChange(opt.value)}
                className="flex items-center justify-between rounded-[8px] px-3 py-2 text-[13px] text-(--foreground) hover:bg-(--tone-control) cursor-pointer"
              >
                <span>{opt.label}</span>
                {isSelected && <Check className="size-3.5 text-(--brand)" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DAY = 86_400_000;
/** Whether an ISO time falls in the picked range ("30", "7", "today" or "all"). */
function inRange(iso: string, range: string, now = Date.now()) {
  if (range === "all") return true;
  const at = new Date(iso).getTime();
  if (range === "today") return new Date(at).toDateString() === new Date(now).toDateString();
  return at >= now - Number(range) * DAY;
}

/** Options from the sessions themselves, "All …" first. */
function optionsOf(all: string, pairs: [string, string][]) {
  return [{ value: "all", label: all }, ...[...new Map(pairs)].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))];
}

export function TwinSessionsPage({ sessions }: { sessions: TwinSessionItemData[] }) {
  const [botFilter, setBotFilter] = useState("all");
  const [learnerFilter, setLearnerFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("30");

  const agentOptions = optionsOf("All twin agents", sessions.map((s) => [s.agentSlug, s.agentName]));
  const learnerOptions = optionsOf("All learners", sessions.map((s) => [s.learnerEmail, s.learner]));
  const filteredSessions = sessions.filter((s) => {
    if (botFilter !== "all" && s.agentSlug !== botFilter) return false;
    if (learnerFilter !== "all" && s.learnerEmail !== learnerFilter) return false;
    return inRange(s.at, dateFilter);
  });

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 md:px-0 pt-5 pb-16">
        <header className="flex min-h-10 flex-wrap items-center justify-between gap-4">
          <h1 className="m-0 flex items-center gap-2 text-[16px] font-semibold leading-[22px] tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <SessionsIcon className="size-[18px]" />
            </span>
            Twin sessions
          </h1>

          {/* Reference ts-filters: rounded-full pills opening shadcn DropdownMenu */}
          <div className="flex flex-wrap items-center gap-2.5">
            <FilterDropdown
              value={botFilter}
              onChange={setBotFilter}
              options={agentOptions}
            />
            <FilterDropdown
              value={learnerFilter}
              onChange={setLearnerFilter}
              options={learnerOptions}
            />
            <FilterDropdown
              value={dateFilter}
              onChange={setDateFilter}
              options={DATE_OPTIONS}
            />
          </div>
        </header>

        <div className="mt-10">
          <h2 className="m-0 text-[18px] font-semibold leading-6 tracking-[-0.015em]">Sessions</h2>
          <p className="mt-1 text-sm text-muted-foreground">Questions your learners asked your twins</p>
        </div>

        {/* Reference sess-list */}
        <ul className="mt-4 flex flex-col overflow-hidden rounded-[16px] border border-(--card-border) bg-card p-0 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          {filteredSessions.length === 0 ? (
            <li className="p-8 text-center text-sm text-muted-foreground">No sessions match these filters.</li>
          ) : (
            filteredSessions.map((c, idx) => (
              <TwinSessionItem
                key={c.id}
                session={c}
                index={idx}
                divider={idx > 0}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
