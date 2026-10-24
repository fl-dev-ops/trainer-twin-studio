"use client";

import Link from "next/link";
import { useOrgCopy, useOrgType } from "@/components/org-type-provider";
import { cn } from "@/lib/utils";

export function ScenarioSectionNav({ active }: { active: "scenarios" | "fidelity" }) {
  const copy = useOrgCopy();
  // Fidelity compares the trainer's twin with their recordings; sales orgs have no twin.
  if (useOrgType() === "SALES") return null;
  return (
    <nav aria-label={`${copy.scenario} sections`} className="flex gap-6 border-b">
      {([
        ["scenarios", copy.scenarios, "/agents"],
        ["fidelity", "Fidelity", "/agents/fidelity"],
      ] as const).map(([value, label, href]) => (
        <Link
          key={value}
          href={href}
          className={cn(
            "-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors",
            active === value
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
