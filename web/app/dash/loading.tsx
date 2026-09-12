import { LoadingCards, LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function DashLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <LoadingCards count={3} />
      <LoadingRows rows={5} />
    </LoadingPage>
  );
}
