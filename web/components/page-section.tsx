import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The bordered card that holds a section's content (a form, list or table): the only gray surface in a section. */
export const SECTION_CARD = "rounded-tt-lg border border-(--card-border) bg-card shadow-card";

/**
 * A section of a settings-like page (Usage, Billing, Settings): its title, description and action outside, then the
 * content, usually in a SECTION_CARD. Named after its title, so tests and screen readers can find it as a region.
 */
export function PageSection({ title, label, description, action, children, className }: {
  title: ReactNode;
  /** The region's name when the title isn't plain text. */
  label?: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label ?? (typeof title === "string" ? title : undefined)} className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-h-8 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold">{title}</h2>
          {description ? <p className="m-0 mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One row of a SECTION_CARD list: a label and its detail on the left, an action, value or form control on the right
 * (stacked on small screens). Rows are divided by a line.
 */
export function SectionRow({ title, detail, children, className }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 border-t border-(--border) px-5 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {detail ? <div className="mt-0.5 text-sm text-muted-foreground">{detail}</div> : null}
      </div>
      {children ? <div className="flex items-center gap-2 sm:shrink-0">{children}</div> : null}
    </div>
  );
}
