import { LoadingCard, LoadingPage } from "@/components/page-skeletons";

/** A session: who and when with the recording, the evaluation, the transcript. */
export default function Loading() {
  return (
    <LoadingPage className="flex flex-col gap-4">
      <LoadingCard lines={2} className="mt-8" />
      <LoadingCard lines={4} />
      <LoadingCard lines={8} />
    </LoadingPage>
  );
}
