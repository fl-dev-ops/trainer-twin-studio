import { LoadingCard, LoadingPage, LoadingPageHeader } from "@/components/page-skeletons";

/** Overview: header, three counts, recent sessions. */
export default function Loading() {
  return (
    <LoadingPage className="flex flex-col gap-6">
      <LoadingPageHeader description actions={1} className="border-b pb-6" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <LoadingCard lines={1} />
        <LoadingCard lines={1} />
        <LoadingCard lines={1} />
      </div>
      <LoadingCard lines={6} />
    </LoadingPage>
  );
}
