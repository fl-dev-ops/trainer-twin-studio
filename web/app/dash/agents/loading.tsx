import { LoadingList, LoadingPage, LoadingPageHeader } from "@/components/page-skeletons";

/** Scenarios index. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingPageHeader description actions={1} />
      <LoadingList rows={5} className="mt-6" />
    </LoadingPage>
  );
}
