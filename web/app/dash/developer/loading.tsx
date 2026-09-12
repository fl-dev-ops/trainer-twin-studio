import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function DeveloperLoading() {
  return (
    <LoadingPage>
      <LoadingHeader />
      <div className="mt-8">
        <LoadingRows rows={4} />
      </div>
    </LoadingPage>
  );
}
