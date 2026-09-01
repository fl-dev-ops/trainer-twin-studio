import { redirect } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { OrganizationForm, ProfileForm } from "@/components/profile-form";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { user } = await resolveSessionUser();
  if (!user) redirect("/auth/sign-in");

  const membership = await db.member.findFirst({
    where: { userId: user.id },
    select: {
      organization: { select: { id: true, name: true, slug: true, logo: true, metadata: true } },
    },
  });
  if (!membership) redirect("/auth/no-org");

  // ponytail PT-1: parsing accentColor from the metadata blob.
  const accentColor = (() => {
    try {
      const m = JSON.parse(membership.organization.metadata ?? "{}");
      return typeof m.accentColor === "string" ? m.accentColor : null;
    } catch {
      return null;
    }
  })();

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow">
        <PageHeader
          className="border-b pb-6"
          title="Profile"
          description="Manage the details shown across your TrainerTwin workspace."
        />

        <ProfileForm user={user} />

        <section className="mt-8" aria-labelledby="organization-heading">
          <h2 id="organization-heading" className="text-lg font-semibold">
            Organization
          </h2>
          <OrganizationForm organization={{ ...membership.organization, accentColor }} />
        </section>
      </PageContainer>
    </main>
  );
}
