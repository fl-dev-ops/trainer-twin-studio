"use client";

import { useParams } from "next/navigation";
import { TwinLearnerFlow } from "@/components/twin/twin-learner-flow";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, useApi } from "@/lib/api";

/**
 * A twin's readable link: /t/<username> (the trainer's main twin) or /t/<slug> (a skill twin). Everything happens on
 * this page, never on the auth pages: what the twin is, signing in (Google), the person's access and minutes, the call
 * and its summary with feedback. Only people in this org with an active assignment can talk; they use their own
 * minutes. Studio members (admin, team) see a preview: the same page, calls that use no minutes and aren't counted.
 */
export default function TwinLinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const loaded = useApi(["page.twinLink", slug], () => api.page.twinLink.query({ slug }));
  if (loaded.kind === "flow") return <TwinLearnerFlow {...loaded.props} />;
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle>Twin not found</CardTitle>
          <CardDescription>This link doesn&apos;t open a twin. Ask your trainer for a new one.</CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
