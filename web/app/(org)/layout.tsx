import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LearnerShell } from "@/components/learner-shell";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function LearnerLayout({ children }: { children: ReactNode }) {
  const host = (await headers()).get("host") ?? "";
  const slug = host.split(":")[0].split(".")[0];
  const org = await db.organization.findUnique({
    where: { slug },
    select: { name: true, logo: true, metadata: true },
  });
  if (!org) redirect("/auth/sign-in");

  // ponytail PT-1: parsing accentColor from metadata blob; move to own column when metadata grows.
  const accentColor = (() => {
    try {
      const m = JSON.parse(org.metadata ?? "{}");
      return typeof m.accentColor === "string" ? m.accentColor : null;
    } catch {
      return null;
    }
  })();

  const logo = /^data:image\/(?:png|jpeg|webp);base64,/.test(org.logo ?? "") ? org.logo : null;
  return <LearnerShell orgName={org.name} logo={logo} accentColor={accentColor}>{children}</LearnerShell>;
}
