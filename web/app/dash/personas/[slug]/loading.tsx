import { LoadingHeader, LoadingPage, LoadingRows } from "@/components/page-skeletons";

/** Persona detail / role-play preview: a page header and its sections. */
export default function DetailLoading() {
  return (
    <LoadingPage>
      <LoadingHeader action />
      <LoadingRows rows={6} />
    </LoadingPage>
  );
}
