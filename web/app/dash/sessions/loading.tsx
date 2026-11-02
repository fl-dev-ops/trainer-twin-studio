import { LoadingList, LoadingPage, LoadingPageHeader, LoadingSectionTitle } from "@/components/page-skeletons";

/** Sessions: header with three filters, then the session list. */
export default function Loading() {
  return (
    <LoadingPage className="flex flex-col gap-8">
      <LoadingPageHeader actions={3} />
      <section className="flex flex-col gap-3">
        <LoadingSectionTitle className="" />
        <LoadingList rows={8} className="" />
      </section>
    </LoadingPage>
  );
}
