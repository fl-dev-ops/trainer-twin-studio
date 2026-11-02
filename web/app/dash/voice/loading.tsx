import { LoadingCardGrid, LoadingPage, LoadingPageHeader, LoadingTabs } from "@/components/page-skeletons";

/** Voices: header with Clone voice, Explore / My voices tabs, the voice cards. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingPageHeader description actions={1} className="border-b pb-6" />
      <LoadingTabs count={2} className="mt-6" />
      <LoadingCardGrid count={6} className="mt-4" />
    </LoadingPage>
  );
}
