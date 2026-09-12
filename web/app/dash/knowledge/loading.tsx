import { Skeleton } from "@/components/ui/skeleton";
import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function KnowledgeLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
      <LoadingRows rows={6} />
    </LoadingPage>
  );
}
