import { LoadingList, LoadingPage, LoadingPageHeader, LoadingSectionTitle } from "@/components/page-skeletons";

/** Learners: header, then the learner list. */
export default function Loading() {
  return (
    <LoadingPage className="flex flex-col gap-8">
      <LoadingPageHeader />
      <section className="flex flex-col gap-3">
        <LoadingSectionTitle className="" />
        <LoadingList rows={6} className="" />
      </section>
    </LoadingPage>
  );
}
