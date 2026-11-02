import { LoadingPage, LoadingPageHeader } from "@/components/page-skeletons";

/** Twin settings: the header (the page has nothing else yet). */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingPageHeader description />
    </LoadingPage>
  );
}
