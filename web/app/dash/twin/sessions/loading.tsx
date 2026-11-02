import { LoadingTable } from "@/components/page-skeletons";

/** Twin sessions: three filter pills, then the session list. */
export default function Loading() {
  return <LoadingTable actions={3} />;
}
