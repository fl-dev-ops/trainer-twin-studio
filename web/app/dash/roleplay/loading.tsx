import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function RoleplayLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <LoadingRows rows={6} />
    </LoadingPage>
  );
}
