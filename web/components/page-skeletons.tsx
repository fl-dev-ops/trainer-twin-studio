import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Shared loading skeletons mirroring the app's PageContainer/PageHeader layouts. */

export function LoadingPage({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-6", className)}>{children}</div>
    </main>
  );
}

/** Mirrors PageHeader: title + description + optional action button. */
export function LoadingHeader({ className, action }: { className?: string; action?: boolean }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b pb-6", className)}>
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {action && <Skeleton className="h-9 w-28 shrink-0 rounded-md" />}
    </div>
  );
}

/** Grid of card placeholders (index pages, persona/agent/voice grids). */
export function LoadingCards({ count = 6, className, cols = "md:grid-cols-2 xl:grid-cols-3" }: {
  count?: number;
  className?: string;
  cols?: string;
}) {
  return (
    <div className={cn("grid gap-4", cols, className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** Table/list row placeholders. */
export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("rounded-xl border", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Fullscreen practice stage (SessionView): header row + centered setup card. */
export function LoadingStage() {
  return (
    <div className="dark fixed inset-0 z-50 flex h-dvw w-dvw flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <Skeleton className="h-9 w-24 rounded-md" />
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center p-3 sm:p-4">
        <div className="w-full max-w-xl space-y-4 rounded-xl border p-6">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </main>
    </div>
  );
}

/** Centered card (auth-style pages). */
export function LoadingCenteredCard({ className, wide }: { className?: string; wide?: boolean }) {
  return (
    <main className={cn("flex min-h-svh items-center justify-center p-4", className)}>
      <div className={cn("w-full space-y-4 rounded-xl border p-6", wide ? "max-w-lg" : "max-w-sm")}>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <div className="space-y-3 pt-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>
    </main>
  );
}
