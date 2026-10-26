import { Skeleton } from "@/components/ui/skeleton";
import { LoadingHeader, LoadingPage } from "@/components/page-skeletons";

export default function ProfileLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </LoadingPage>
  );
}
