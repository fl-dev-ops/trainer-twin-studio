"use client";

import { OrgHome } from "@/components/org/org-home";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, useApi } from "@/lib/api";

/** The org's home page (<org>.<base>/): the org, its trainers' twins and your role plays (lib/pages/org-home.ts). */
export default function OrgHomePage() {
  const loaded = useApi(["page.orgHome"], () => api.page.orgHome.query());
  if (loaded.kind === "home") return <OrgHome {...loaded.props} />;
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle>Organization not found</CardTitle>
          <CardDescription>This address doesn&apos;t belong to an organization on TrainerTwin.</CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
