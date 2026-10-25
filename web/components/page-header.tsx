import type { ComponentProps, ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page title row (V2 prototype): icon + title on the left, actions on the right. */
export function PageHeader({
  actions,
  className,
  description,
  icon: Icon,
  title,
  ...props
}: Omit<ComponentProps<"header">, "title"> & {
  actions?: ReactNode;
  description?: ReactNode;
  /** Usually the page's sidebar icon. */
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="flex min-h-8 items-center gap-2 text-base font-semibold tracking-[-0.015em]">
          {Icon ? <Icon className="size-[18px] shrink-0 text-muted-foreground" /> : null}
          {title}
        </h1>
        {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {actions && (
        <div
          data-slot="page-header-actions"
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end"
        >
          {actions}
        </div>
      )}
    </header>
  );
}

/** Section title row inside a page: heading on the left, a short note on the right. */
export function SectionHeader({ title, note, className }: { title: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-2", className)}>
      <h2 className="text-lg font-semibold tracking-[-0.015em]">{title}</h2>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
