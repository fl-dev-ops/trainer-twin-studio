import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiKeyManager } from "@/components/api-key-manager";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { auth } from "@/lib/auth";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db } from "@/lib/db";

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ??
  (process.env.NODE_ENV === "development"
    ? `https://docs.${BASE_DOMAIN}`
    : "https://docs.trainertwin.com");

export const dynamic = "force-dynamic";

export default async function DeveloperApiPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");

  const membership = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { role: true, organization: { select: { id: true } } },
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

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow">
        <PageHeader
          className="border-b pb-6"
          title="Developer API"
          description="Generate organization-scoped keys for server-to-server integrations."
          actions={
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href={`${DOCS_URL}/quickstart`} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLink />
              API docs
            </Button>
          }
        />

        {canManageApiKeys ? (
          <div className="mt-8">
            <ApiKeyManager
              initialKeys={apiKeys.map((key) => ({
                ...key,
                expiresAt: key.expiresAt?.toISOString() ?? null,
                lastRequest: key.lastRequest?.toISOString() ?? null,
                createdAt: key.createdAt.toISOString(),
              }))}
            />
          </div>
        ) : (
          <p className="mt-8 text-sm text-muted-foreground">
            Only organization owners and admins can manage API keys.
          </p>
        )}
      </PageContainer>
    </main>
  );
}
