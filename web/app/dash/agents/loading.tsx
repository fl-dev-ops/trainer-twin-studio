import { LoadingCards, LoadingHeader, LoadingPage } from "@/components/page-skeletons";

export default function AgentsLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <div className="mt-6">
        <LoadingCards count={6} />
      </div>
    </LoadingPage>
  );
}
