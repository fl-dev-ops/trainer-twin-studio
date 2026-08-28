import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  actions,
  className,
  description,
  title,
  ...props
}: Omit<ComponentProps<"header">, "title"> & {
  actions?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div data-slot="page-header-actions" className="flex shrink-0 items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
