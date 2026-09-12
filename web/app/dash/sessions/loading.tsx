import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function SessionsLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <LoadingRows rows={8} />
    </LoadingPage>
  );
}
