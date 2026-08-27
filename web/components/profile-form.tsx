"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Building2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function ProfileForm({
  user,
}: {
  user: { name: string; email: string };
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) {
      setError("Enter your name.");
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await authClient.updateUser({ name });
    setSaving(false);
    if (result.error) {
      setError(result.error.message ?? "Could not update your profile.");
      return;
    }
    setSaved(true);
  }

  return (
    <Card className="mt-6">
      <CardContent>
        <form onSubmit={saveProfile} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                name="name"
                defaultValue={user.name}
                autoComplete="name"
                aria-invalid={Boolean(error)}
                required
              />
              <FieldError>{error}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" value={user.email} autoComplete="email" readOnly />
              <FieldDescription>Your email is managed by your account.</FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {saved ? "Profile updated." : null}
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function OrganizationForm({
  organization,
}: {
  organization: { id: string; name: string; slug: string; logo?: string | null; accentColor?: string | null };
}) {
  const logoInput = useRef<HTMLInputElement>(null);
  const [logo, setLogo] = useState(organization.logo ?? null);
  const [logoName, setLogoName] = useState<string | null>(null);
  const [readingLogo, setReadingLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Backup previous default brand color: #ec3013
  const DEFAULT_ACCENT = "#4648D4";
  const [accent, setAccent] = useState(organization.accentColor ?? DEFAULT_ACCENT);

  async function saveOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("organizationName") ?? "").trim();
    if (!name) {
      setError("Enter an organization name.");
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await authClient.organization.update({
      organizationId: organization.id,
      data: { name, logo },
    });
    if (result.error) {
      setSaving(false);
      setError(result.error.message ?? "Could not update the organization.");
      return;
    }

    // ponytail PT-4: accent color saved in a separate fetch, not atomic with org.update(); unify when settings grow.
    await fetch("/api/org/accent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accentColor: accent }),
    });

    // ponytail PT-5: full reload so the server layout re-fetches accentColor and OrgAccentProvider updates.
    // Swap for router.refresh() once the prop-threading is stable.
    window.location.reload();
  }

  function uploadLogo(file?: File) {
    if (!file) return;
    setLogoError(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setLogoError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    // ponytail: small logos live in Better Auth's logo field; move them to S3 if asset needs grow.
    if (file.size > 1_000_000) {
      setLogoError("Choose an image smaller than 1 MB.");
      return;
    }
    setLogoName(file.name);
    setReadingLogo(true);
    const reader = new FileReader();
    reader.onload = () => {
      setLogo(String(reader.result));
      setReadingLogo(false);
    };
    reader.onerror = () => {
      setLogoError("Could not read that image.");
      setReadingLogo(false);
    };
    reader.readAsDataURL(file);
  }

  return (
    <Card className="mt-3">
      <CardContent>
        <form onSubmit={saveOrganization} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={Boolean(logoError)}>
              <FieldLabel htmlFor="organization-logo">Logo</FieldLabel>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <span className="bg-muted grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl border">
                  {logo ? (
                    <Image
                      src={logo}
                      alt=""
                      width={56}
                      height={56}
                      className="size-full object-contain"
                      unoptimized
                    />
                  ) : (
                    <Building2 className="text-muted-foreground" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {logoName ?? (logo ? "Current logo" : "No logo uploaded")}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    PNG, JPEG, or WebP · Maximum 1 MB
                  </p>
                </div>
                <Input
                  ref={logoInput}
                  id="organization-logo"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(event) => uploadLogo(event.target.files?.[0])}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={readingLogo}
                  onClick={() => logoInput.current?.click()}
                >
                  <Upload data-icon="inline-start" />
                  {readingLogo ? "Reading…" : logo ? "Replace logo" : "Upload logo"}
                </Button>
              </div>
              <FieldError>{logoError}</FieldError>
            </Field>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="organization-name">Name</FieldLabel>
              <Input
                id="organization-name"
                name="organizationName"
                defaultValue={organization.name}
                aria-invalid={Boolean(error)}
                required
              />
              <FieldError>{error}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Workspace</FieldLabel>
              <p className="text-sm font-medium">{organization.slug}</p>
            </Field>
            <Field>
              <FieldLabel htmlFor="accent-color">Accent color</FieldLabel>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  id="accent-color"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  aria-label="Pick accent color"
                />
                <Input
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  pattern="^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"
                  maxLength={7}
                  className="w-28 font-mono"
                  aria-label="Hex color value"
                />
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  onClick={() => setAccent(DEFAULT_ACCENT)}
                >
                  Reset
                </button>
              </div>
              <FieldDescription>
                Applies to buttons and interactive highlights across the workspace.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={saving || readingLogo}>
              {saving ? "Saving…" : readingLogo ? "Reading image…" : "Save changes"}
            </Button>
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {saved ? "Organization updated." : null}
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
