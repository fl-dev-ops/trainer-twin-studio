"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SwitchAccountButton({ returnTo, label = "Switch account" }: { returnTo: string; label?: string }) {
  const [error, setError] = useState<string | null>(null);

  async function switchAccount() {
    const { error } = await authClient.signOut();
    if (error) {
      setError(error.message ?? "Could not sign out. Try again.");
      return;
    }
    window.location.assign(returnTo);
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={switchAccount}>{label}</Button>
      {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
    </>
  );
}
