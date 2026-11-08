"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";
import { SwitchAccountButton } from "@/components/auth/switch-account-button";
import { LoadingCenteredCard } from "@/components/page-skeletons";
import { HomeRedirect } from "@/components/session/home-redirect";
import { SessionView } from "@/components/session-view";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, useApi } from "@/lib/api";

/** /s/<code>: a role-play invite, or a twin assignment / share link, for the signed-in learner (lib/pages/learner.ts). */
export default function SharedSessionPage() {
  const { code } = useParams<{ code: string }>();
  const loaded = useApi(["page.sharedSession", code], () => api.page.sharedSession.query({ code }));

  if (loaded.kind === "signIn") return <SignIn url={loaded.url} />;
  if (loaded.kind === "session") return <SessionView {...loaded.props} />;
  if (loaded.kind === "twinUnavailable") {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Twin not available</CardTitle>
            <CardDescription>
              {loaded.message}. You are signed in as {loaded.email}.
              <HomeRedirect />
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  if (loaded.kind === "outOfMinutes") {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Out of practice minutes</CardTitle>
            <CardDescription>
              You&apos;ve used all your practice minutes. Ask your trainer for more. You are signed in as {loaded.email}.
              <HomeRedirect />
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  if (loaded.kind === "switchAccount") {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Use your invited account</CardTitle>
            <CardDescription>
              You are signed in as {loaded.email}. Use the account your trainer assigned to open this practice link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SwitchAccountButton returnTo={loaded.returnTo} />
          </CardContent>
        </Card>
      </main>
    );
  }
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle>Invalid session link</CardTitle>
          <CardDescription>
            This practice link is not assigned to your account, has expired, or has already been completed.
            <HomeRedirect />
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

/** Signed out: the auth host (another origin) signs them in and sends them back here. */
function SignIn({ url }: { url: string }) {
  useEffect(() => window.location.replace(url), [url]);
  return <LoadingCenteredCard />;
}
