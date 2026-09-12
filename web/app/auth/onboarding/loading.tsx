import { Skeleton } from "@/components/ui/skeleton";

/** Onboarding: header + step indicator + founder form card. */
export default function OnboardingLoading() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-2 w-16 rounded-full" />
        <Skeleton className="h-2 w-16 rounded-full" />
        <Skeleton className="h-2 w-16 rounded-full" />
      </div>
      <div className="w-full max-w-lg space-y-4 rounded-xl border p-6">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <div className="space-y-3 pt-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    </main>
  );
}
