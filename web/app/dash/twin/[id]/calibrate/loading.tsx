import { LoadingCard, LoadingPage, LoadingTitleBar } from "@/components/page-skeletons";

/** Calibrate (text cards): a studio page with the left navigation. */
export default function Loading() {
  return (
    <LoadingPage className="max-w-[760px]">
      <LoadingTitleBar actions={2} />
      <LoadingCard className="mt-6" lines={2} />
      <LoadingCard className="mt-4" lines={4} />
    </LoadingPage>
  );
}
