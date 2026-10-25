"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RANGE_OPTIONS } from "./session-range";

type Option = { value: string; label: string };

function FilterSelect({ param, value, options, label }: { param: string; value: string; options: Option[]; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  return (
    <Select
      value={value}
      items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
      onValueChange={(next) => {
        if (next === null) return;
        const params = new URLSearchParams(searchParams);
        params.set(param, String(next));
        startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
      }}
    >
      <SelectTrigger
        aria-label={label}
        data-pending={pending}
        className="h-8 w-44 rounded-full pr-3 pl-4 text-[13px] font-medium data-[pending=true]:opacity-60"
      >
        <SelectValue className="truncate" />
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        sideOffset={6}
        className="w-auto max-w-[min(22rem,var(--available-width))] min-w-(--anchor-width) rounded-xl p-1"
      >
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="rounded-lg py-1.5 pl-2.5">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SessionFilters({
  scenarios,
  learners,
  scenario,
  learner,
  range,
}: {
  scenarios: Option[];
  learners: Option[];
  scenario: string;
  learner: string;
  range: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect param="scenario" label="Scenario" value={scenario} options={[{ value: "all", label: "All scenarios" }, ...scenarios]} />
      <FilterSelect param="learner" label="Learner" value={learner} options={[{ value: "all", label: "All learners" }, ...learners]} />
      <FilterSelect param="range" label="Date range" value={range} options={[...RANGE_OPTIONS]} />
    </div>
  );
}
