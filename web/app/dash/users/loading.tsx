import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function UsersLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <LoadingRows rows={8} />
    </LoadingPage>
  );
}
