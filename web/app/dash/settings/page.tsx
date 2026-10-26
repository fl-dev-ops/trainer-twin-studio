import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import { SettingsIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { OrganizationForm, ProfileForm } from "@/components/profile-form";
import { TeamSection } from "@/components/users/team-section";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");

  const membership = await db.member.findFirst({
    where: { userId: session.user.id },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true, logo: true, websiteUrl: true, metadata: true } },
    },
  });
  if (!membership) redirect("/auth/no-org");
  const orgId = membership.organization.id;

  // Team: studio only (admin, team). Everyone in the org plus pending invites; disabled members stay listed.
  const team = isStudioRole(membership.role)
    ? await Promise.all([
        db.member.findMany({
          where: { organizationId: orgId },
          orderBy: { createdAt: "asc" },
          select: { id: true, userId: true, role: true, createdAt: true, disabledAt: true, user: { select: { name: true, email: true } } },
        }),
        db.invitation.findMany({
          where: { organizationId: orgId, status: "pending", expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
          select: { id: true, email: true, role: true, expiresAt: true },
        }),
      ])
    : null;

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
          icon={SettingsIcon}
          title="Settings"
          description="Manage the details shown across your TrainerTwin workspace."
        />

        <ProfileForm user={session.user} />

        <section className="mt-8" aria-labelledby="organization-heading">
          <h2 id="organization-heading" className="text-lg font-semibold">
            Organization
          </h2>
          <OrganizationForm organization={{ ...membership.organization, accentColor }} />
        </section>

        {team ? (
          <section id="team" className="mt-8 scroll-mt-8" aria-labelledby="team-heading">
            <h2 id="team-heading" className="text-lg font-semibold">
              Team and users
            </h2>
            <p className="text-sm text-muted-foreground">
              Invite people by email. Team members run the studio; users practise. Disabled people cannot sign in.
            </p>
            <TeamSection
              organizationId={orgId}
              currentUserId={session.user.id}
              members={team[0].map(({ user, createdAt, disabledAt, ...member }) => ({
                ...member,
                name: user.name,
                email: user.email,
                createdAt: createdAt.toISOString(),
                disabledAt: disabledAt?.toISOString() ?? null,
              }))}
              invitations={team[1].map((invitation) => ({ ...invitation, expiresAt: invitation.expiresAt.toISOString() }))}
            />
          </section>
        ) : null}
      </PageContainer>
    </main>
  );
}
