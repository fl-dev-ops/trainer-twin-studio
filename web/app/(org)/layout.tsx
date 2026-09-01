import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LearnerShell } from "@/components/learner-shell";
import { db } from "@/lib/db";
import { parseAccentColor, parseBasePath } from "@/lib/org";
import { tenantSlug, signInUrl } from "@/lib/base-domain";

export const dynamic = "force-dynamic";

export default async function LearnerLayout({ children }: { children: ReactNode }) {
  const host = (await headers()).get("host") ?? "";
  const slug = tenantSlug(host, (await headers()).get("x-tenant-slug"));
  const org = await db.organization.findUnique({
    where: { slug },
    select: { name: true, logo: true, metadata: true, config: true },
  });
  if (!org) redirect(signInUrl(host));

  const accentColor = parseAccentColor(org.metadata);
  const basePath = parseBasePath(org.config);
  const logo = /^data:image\/(?:png|jpeg|webp);base64,/.test(org.logo ?? "") ? org.logo : null;
  return <LearnerShell orgName={org.name} logo={logo} accentColor={accentColor} basePath={basePath}>{children}</LearnerShell>;
}
