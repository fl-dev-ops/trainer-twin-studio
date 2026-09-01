import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiKeyManager } from "@/components/api-key-manager";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { OrganizationForm, ProfileForm } from "@/components/profile-form";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");

  const membership = await db.member.findFirst({
    where: { userId: session.user.id },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true, logo: true, metadata: true } },
    },
  });
  if (!membership) redirect("/auth/no-org");

  const canManageApiKeys = membership.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()));
  const apiKeys = canManageApiKeys
    ? await db.apikey.findMany({
        where: { referenceId: membership.organization.id, configId: "default" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          start: true,
          enabled: true,
          expiresAt: true,
          lastRequest: true,
          createdAt: true,
        },
      })
    : [];

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

        <ProfileForm user={session.user} />

        <section className="mt-8" aria-labelledby="organization-heading">
          <h2 id="organization-heading" className="text-lg font-semibold">
            Organization
          </h2>
          <OrganizationForm organization={{ ...membership.organization, accentColor }} />
        </section>

        {canManageApiKeys && (
          <section className="mt-8" aria-labelledby="developer-api-heading">
            <h2 id="developer-api-heading" className="text-lg font-semibold">
              Developer API
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Generate organization-scoped keys for server-to-server integrations.
            </p>
            <ApiKeyManager
              initialKeys={apiKeys.map((key) => ({
                ...key,
                expiresAt: key.expiresAt?.toISOString() ?? null,
                lastRequest: key.lastRequest?.toISOString() ?? null,
                createdAt: key.createdAt.toISOString(),
              }))}
            />
          </section>
        )}
      </PageContainer>
    </main>
  );
}
