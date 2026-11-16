import { Skeleton } from "@/components/ui/skeleton";

export default function SignInLoading() {
  return (
    <main aria-busy="true" aria-label="Loading sign-in" className="flex min-h-svh items-center justify-center bg-background px-6 py-12 sm:px-10">
      <div aria-hidden="true" className="flex w-full max-w-[400px] flex-col gap-10">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="mb-2 size-10 rounded-lg" />
          <Skeleton className="h-7 w-64 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-11 w-full rounded-xl" />
          <div className="flex h-7 items-center"><Skeleton className="h-px w-full" /></div>
          <div className="flex flex-col gap-2"><Skeleton className="h-4 w-12" /><Skeleton className="h-11 w-full rounded-xl" /></div>
          <Skeleton className="h-11 w-full rounded-xl" />
        </div>
        <Skeleton className="mx-auto mt-2 h-4 w-64 max-w-full" />
      </div>
    </main>
  );
}
