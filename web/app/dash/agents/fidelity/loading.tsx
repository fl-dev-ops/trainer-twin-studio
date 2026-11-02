import { LoadingCard, LoadingPage, LoadingPageHeader, LoadingTabs } from "@/components/page-skeletons";

/** Fidelity: header, section nav, the report. */
export default function Loading() {
  return (
    <LoadingPage className="space-y-6">
      <LoadingPageHeader description />
      <LoadingTabs count={2} />
      <LoadingCard lines={6} />
    </LoadingPage>
  );
}
