import { Spinner } from "@/components/ui/spinner";

/** Domains redirects to /agents; a bare spinner is all this route can show. */
export default function DomainsLoading() {
  return (
    <main className="grid min-h-0 flex-1 place-items-center">
      <Spinner className="size-6 text-muted-foreground" />
    </main>
  );
}
