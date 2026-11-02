import { Skeleton } from "@/components/ui/skeleton";
import { LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function SessionDetailLoading() {
  return (
    <LoadingPage>
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
    </LoadingPage>
  );
}
