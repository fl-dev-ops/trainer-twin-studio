import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Every dashboard page: one scroll area, one gutter and one content width (1024px), so pages never drift apart.
 * `className` styles the content column (e.g. `flex flex-col gap-6`). Only immersive screens render without it:
 * talk, calibration, capture flows, the copilot chat and the full-height editors.
 */
export function PageContainer({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="page" className="min-h-0 w-full flex-1 overflow-y-auto px-4 md:px-8">
      <div data-slot="page-container" className={cn("mx-auto w-full max-w-[1024px] pt-5 pb-16", className)} {...props} />
    </div>
  );
}
