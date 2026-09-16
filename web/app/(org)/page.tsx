import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { portalSlug } from "@/lib/base-domain";

const FALLBACK_WEBSITE = "https://www.trainertwin.com";

export default async function OrganizationRedirectPage() {
  const host = (await headers()).get("host") ?? "";
  const org = await db.organization.findUnique({
    where: { slug: portalSlug(host) },
    select: { websiteUrl: true },
  });

  let destination = FALLBACK_WEBSITE;
  if (org?.websiteUrl) {
    try {
      const url = new URL(org.websiteUrl);
      if (url.protocol === "https:" && url.hostname !== host.split(":")[0]) {
        destination = url.toString();
      }
    } catch {
      // Invalid legacy/manual values use the safe product fallback.
    }
  }
  redirect(destination);
}
