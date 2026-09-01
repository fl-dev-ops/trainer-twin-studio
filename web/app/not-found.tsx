import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolveSessionUser } from "@/lib/session-user";
import { tenantLink } from "@/lib/tenant-link";

export default async function NotFound() {
  const { org } = await resolveSessionUser();
  const basePath = org?.basePath;

  return (
    <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-16">
      <section className="flex max-w-lg flex-col items-start">
        <Image
          src={tenantLink("/trainertwin-mark.svg", basePath)}
          alt=""
          width={61}
          height={46}
          className="mb-10 h-9 w-auto"
          priority
        />
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          That page isn’t here.
        </h1>
        <p className="mt-5 max-w-md text-pretty text-base leading-7 text-muted-foreground">
          Error 404. The address may be outdated, or the page may have moved. Return to the studio or start a new training session.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button nativeButton={false} render={<Link href={tenantLink("/", basePath)} />}>
            <ArrowLeft data-icon="inline-start" /> Back to dashboard
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href={tenantLink("/talk", basePath)} />}>
            <Play data-icon="inline-start" /> Start a session
          </Button>
        </div>
      </section>
    </main>
  );
}
