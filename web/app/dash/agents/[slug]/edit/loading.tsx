import { Skeleton } from "@/components/ui/skeleton";

/** SpecResourcePage: back bar + main editor panel with right-side source aside. */
export default function AgentDetailLoading() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-4 w-48" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-5 sm:p-8">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <div className="space-y-4">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        </div>
        <aside className="space-y-3 bg-muted/20 border-t p-4 sm:p-6 lg:w-80 lg:border-t-0 lg:border-l">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </aside>
      </div>
    </main>
  );
}
