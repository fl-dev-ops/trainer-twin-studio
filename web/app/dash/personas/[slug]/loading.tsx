import { LoadingCard, LoadingList, LoadingPage, LoadingTitleBar } from "@/components/page-skeletons";

/** A persona: back + Edit, the persona card, its details. */
export default function Loading() {
  return (
    <LoadingPage>
      <LoadingTitleBar back actions={1} />
      <LoadingCard lines={3} className="mt-6 h-48" />
      <LoadingList rows={4} />
    </LoadingPage>
  );
}
