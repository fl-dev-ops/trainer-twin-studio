"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { FilterDropdown } from "@/components/filter-dropdown";
import { RANGE_OPTIONS } from "./session-range";

type Option = { value: string; label: string };

/** One URL-driven filter: the shared filter pill, writing its choice into the query string. */
function FilterSelect({ param, value, options, label }: { param: string; value: string; options: Option[]; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  return (
    <span aria-label={label} aria-busy={pending} className={pending ? "opacity-60" : undefined}>
      <FilterDropdown
        value={value}
        options={options}
        onChange={(next) => {
          const params = new URLSearchParams(searchParams);
          params.set(param, next);
          startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
        }}
      />
    </span>
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
