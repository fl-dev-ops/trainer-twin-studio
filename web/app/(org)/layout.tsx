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
    select: { name: true, logo: true },
  });
  if (!org) redirect("/auth/sign-in");

  const logo = /^data:image\/(?:png|jpeg|webp);base64,/.test(org.logo ?? "") ? org.logo : null;
  return <LearnerShell orgName={org.name} logo={logo}>{children}</LearnerShell>;
}
