import { LoadingCards, LoadingHeader, LoadingPage } from "@/components/page-skeletons";

export default function VoiceLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <div className="mt-6">
        <LoadingCards count={4} />
      </div>
    </LoadingPage>
  );
}
