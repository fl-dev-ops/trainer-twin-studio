import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

export default function KnowledgeDetailLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <LoadingRows rows={6} />
    </LoadingPage>
  );
}
