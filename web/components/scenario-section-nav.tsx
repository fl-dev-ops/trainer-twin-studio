import Link from "next/link";
import { cn } from "@/lib/utils";

export function ScenarioSectionNav({ active }: { active: "scenarios" | "fidelity" }) {
  return (
    <nav aria-label="Scenario sections" className="flex gap-6 border-b">
      {([
        ["scenarios", "Scenarios", "/agents"],
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
