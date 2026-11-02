import { LoadingCard, LoadingPage, LoadingPageHeader, LoadingTabs } from "@/components/page-skeletons";

/** Settings: header, Account / Team / Branding tabs, the form. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingPageHeader description className="border-b pb-6" />
      <LoadingTabs className="mt-6" />
      <LoadingCard lines={4} className="mt-4" />
    </LoadingPage>
  );
}
