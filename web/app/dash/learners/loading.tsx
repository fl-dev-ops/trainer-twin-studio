import { LoadingCards, LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function LearnersLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <LoadingCards count={3} cols="sm:grid-cols-3" />
      <LoadingRows rows={6} />
    </LoadingPage>
  );
}
