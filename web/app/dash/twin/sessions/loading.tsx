import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function TwinLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <LoadingRows rows={6} />
    </LoadingPage>
  );
}
