import type { ComponentProps, ComponentType, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The title bar of every dashboard page (V2): the page's icon in a tile and its title, or a back link on detail
 * pages; actions on the right. One component, so pages don't hand-build their own (plans/design-system-alignment.md D4).
 */
export function PageHeader({
  actions,
  back,
  className,
  description,
  icon: Icon,
  title,
  ...props
}: Omit<ComponentProps<"header">, "title"> & {
  actions?: ReactNode;
  /** Detail pages: where "Back" goes, and an optional label instead of "Back". */
  back?: { href: string; label?: ReactNode };
  description?: ReactNode;
  /** Usually the page's sidebar icon. */
  icon?: ComponentType<{ className?: string }>;
  title?: ReactNode;
}) {
  return (
    <header data-slot="page-header" className={cn("flex min-h-10 flex-wrap items-center justify-between gap-4", className)} {...props}>
      <div className="min-w-0">
        {back ? (
          <Link
            href={back.href}
            className="inline-flex items-center gap-2 text-sm text-foreground transition-colors hover:text-muted-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            <span className="truncate">{back.label ?? "Back"}</span>
          </Link>
        ) : null}
        {title ? (
          <h1 className="m-0 flex items-center gap-2 text-page-title leading-page-title font-semibold tracking-title">
            {Icon ? (
              <span className="grid size-7 shrink-0 place-items-center rounded-tt-sm text-(--text-secondary)">
                <Icon className="size-[18px]" />
              </span>
            ) : null}
            {title}
          </h1>
        ) : null}
        {description ? <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div data-slot="page-header-actions" className="flex flex-wrap items-center gap-2.5">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/** A section title inside a page (V2): the 18px heading and a one-line note under it. */
export function SectionHeader({
  title,
  note,
  id,
  className,
}: {
  title: ReactNode;
  note?: ReactNode;
  /** For aria-labelledby on the section it titles. */
  id?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <h2 id={id} className="m-0 text-section-title leading-6 font-semibold tracking-title">
        {title}
      </h2>
      {note ? <p className="mt-1 text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
