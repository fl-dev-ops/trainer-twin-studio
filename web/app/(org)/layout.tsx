import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ClientOnly } from "@/components/client-only";
import { OrgAccentProvider } from "@/components/org-accent-provider";
import { LoadingCenteredCard } from "@/components/page-skeletons";
import { db } from "@/lib/db";
import { parseAccentColor } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function LearnerLayout({ children }: { children: ReactNode }) {
  const host = (await headers()).get("host") ?? "";
  const slug = host.split(":")[0].split(".")[0];
  const org = await db.organization.findUnique({
    where: { slug },
    select: { metadata: true },
  });
  if (!org) redirect("/auth/sign-in");

  return (
    <OrgAccentProvider accentColor={parseAccentColor(org.metadata)}>
      {/* Learner pages render only in the browser and load through /api/trpc (lib/api.ts). */}
      <ClientOnly fallback={<LoadingCenteredCard />}>{children}</ClientOnly>
    </OrgAccentProvider>
  );
}
