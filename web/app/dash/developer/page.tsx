"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiKeyManager } from "@/components/api-key-manager";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { api, useApi } from "@/lib/api";
import { BASE_DOMAIN } from "@/lib/base-domain";

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ??
  (process.env.NODE_ENV === "development"
    ? `https://docs.${BASE_DOMAIN}`
    : "https://docs.trainertwin.com");

export default function DeveloperApiPage() {
  const { canManageApiKeys, apiKeys } = useApi(["page.developer"], () => api.page.developer.query());

  return (
    <PageContainer>
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
          <ApiKeyManager initialKeys={apiKeys} />
        </div>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">
          Only organization owners and admins can manage API keys.
        </p>
      )}
    </PageContainer>
  );
}
