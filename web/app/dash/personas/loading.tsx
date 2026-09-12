import { LoadingCards, LoadingHeader, LoadingPage } from "@/components/page-skeletons";

export default function PersonasLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <div className="mt-6">
        <LoadingCards count={6} />
      </div>
    </LoadingPage>
  );
}
