import { LoadingCard, LoadingPage, LoadingPageHeader, LoadingTabs } from "@/components/page-skeletons";

/** Role-play preview: header, tabs, the overview. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingPageHeader description actions={2} />
      <LoadingTabs className="mt-6" />
      <LoadingCard lines={6} className="mt-4" />
    </LoadingPage>
  );
}
