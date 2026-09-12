import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRows } from "@/components/page-skeletons";

export default function SessionDetailLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <Skeleton className="h-4 w-24" />
        <div className="flex items-start justify-between">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <LoadingRows rows={4} />
        <LoadingRows rows={8} />
      </div>
    </div>
  );
}
