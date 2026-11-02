import { LoadingList, LoadingPage, LoadingPageHeader } from "@/components/page-skeletons";

/** Developer API: header and the API keys table. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingPageHeader description actions={1} className="border-b pb-6" />
      <LoadingList rows={3} header className="mt-8" />
    </LoadingPage>
  );
}
