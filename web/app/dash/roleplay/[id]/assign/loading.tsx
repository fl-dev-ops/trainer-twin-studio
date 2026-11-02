import { LoadingList, LoadingPage, LoadingPageHeader, LoadingTitleBar } from "@/components/page-skeletons";

/** Assign a role play: back, the title with Assign, the members. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingTitleBar back />
      <LoadingPageHeader description actions={1} className="mt-6" />
      <LoadingList rows={5} className="mt-6" />
    </LoadingPage>
  );
}
