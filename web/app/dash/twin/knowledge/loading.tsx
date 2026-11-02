import { LoadingList, LoadingPage, LoadingPageHeader } from "@/components/page-skeletons";

/** Twin knowledge: header with Add source, the action bar, the document list. */
export default function Loading() {
  return (
    <LoadingPage className="flex flex-col gap-6">
      <LoadingPageHeader description actions={1} />
      <LoadingPageHeader actions={2} />
      <LoadingList rows={6} className="" />
    </LoadingPage>
  );
}
