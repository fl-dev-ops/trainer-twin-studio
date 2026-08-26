import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
      organization: { select: { id: true, name: true, slug: true, logo: true } },
    },
  });
  if (!membership) redirect("/auth/no-org");

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <div className="mx-auto max-w-2xl">
        <header className="border-b pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage the details shown across your TrainerTwin workspace.
          </p>
        </header>

        <ProfileForm user={session.user} />

        <section className="mt-8" aria-labelledby="organization-heading">
          <h2 id="organization-heading" className="text-lg font-semibold">
            Organization
          </h2>
          <OrganizationForm organization={membership.organization} />
        </section>
      </div>
    </main>
  );
}
