"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Building2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { CopyButton } from "@/components/users/copy-button";
import { ColorPicker, ColorPickerContent, ColorPickerPanel, ColorPickerTrigger } from "@/components/reui/color-picker";
import { orgHomeUrl } from "@/lib/invite/links";
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
    <PageSection title="Profile" description="Your name, as your team and learners see it.">
      <form onSubmit={saveProfile} className="flex flex-col gap-3">
        <div className={SECTION_CARD}>
          <SectionRow title={<label htmlFor="name">Name</label>}>
            <Control error={error}>
              <Input id="name" name="name" defaultValue={user.name} autoComplete="name" aria-invalid={Boolean(error)} required />
            </Control>
          </SectionRow>
          <SectionRow title="Email">
            <span className="text-sm text-muted-foreground">{user.email}</span>
          </SectionRow>
        </div>
        <SaveRow saving={saving} saved={saved ? "Profile updated." : null} />
      </form>
    </PageSection>
  );
}

/** A form control on the right of a SectionRow, with its error under it. */
function Control({ error, children }: { error?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-1.5 sm:w-72">
      {children}
      {error ? <p role="alert" className="m-0 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Under the form's card, on the page background: what happened, then Save on the right. */
function SaveRow({ saving, saved, busyLabel }: { saving: boolean; saved: string | null; busyLabel?: string | null }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <p className="m-0 text-sm text-muted-foreground" aria-live="polite">{saved}</p>
      <Button type="submit" disabled={saving || Boolean(busyLabel)}>
        {saving ? "Saving…" : busyLabel ?? "Save changes"}
      </Button>
    </div>
  );
}

/** Quick picks under the accent picker: TrainerTwin's default first, then a few strong brand-like hues. */
const ACCENT_SWATCHES = ["#EC3013", "#F97316", "#EAB308", "#16A34A", "#0D9488", "#2563EB", "#7C3AED", "#DB2777", "#111827"];

export function OrganizationForm({
  organization,
}: {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo?: string | null;
    accentColor?: string | null;
    websiteUrl?: string | null;
  };
}) {
  const logoInput = useRef<HTMLInputElement>(null);
  const [logo, setLogo] = useState(organization.logo ?? null);
  const [readingLogo, setReadingLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [websiteError, setWebsiteError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Backup previous default brand color: #ec3013
  // Matches the TrainerTwin logo brand color (globals.css --brand).
  const DEFAULT_ACCENT = "#EC3013";
  const [accent, setAccent] = useState(organization.accentColor ?? DEFAULT_ACCENT);
  const signInPage = orgHomeUrl(organization.slug);

  async function saveOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("organizationName") ?? "").trim();
    const websiteUrl = String(form.get("websiteUrl") ?? "").trim();
    if (!name) {
      setError("Enter an organization name.");
      return;
    }
    if (websiteUrl) {
      try {
        if (new URL(websiteUrl).protocol !== "https:") throw new Error();
      } catch {
        setWebsiteError("Enter a valid HTTPS website URL.");
        return;
      }
    }

    setSaving(true);
    setError(null);
    setWebsiteError(null);
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

    const settingsResponse = await fetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accentColor: accent, websiteUrl }),
    }).catch(() => null);
    if (!settingsResponse?.ok) {
      const response = await settingsResponse?.json().catch(() => null);
      setSaving(false);
      setWebsiteError(response?.error ?? "Could not update organization settings.");
      return;
    }

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
    <PageSection title="Organization" description="Your logo, name, website and accent colour, shown across the workspace and to your learners.">
      <form onSubmit={saveOrganization} className="flex flex-col gap-3">
        <div className={SECTION_CARD}>
          <SectionRow
            title={<label htmlFor="organization-logo">Logo</label>}
            detail={logoError ? <span role="alert" className="text-destructive">{logoError}</span> : null}
          >
            <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted">
              {logo ? (
                <Image src={logo} alt="" width={40} height={40} className="size-full object-contain" unoptimized />
              ) : (
                <Building2 className="size-5 text-muted-foreground" aria-hidden="true" />
              )}
            </span>
            <Input
              ref={logoInput}
              id="organization-logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(event) => uploadLogo(event.target.files?.[0])}
            />
            <Button type="button" variant="outline" size="sm" disabled={readingLogo} onClick={() => logoInput.current?.click()}>
              <Upload data-icon="inline-start" />
              {readingLogo ? "Reading…" : logo ? "Replace" : "Upload"}
            </Button>
          </SectionRow>
          <SectionRow title={<label htmlFor="organization-name">Name</label>}>
            <Control error={error}>
              <Input id="organization-name" name="organizationName" defaultValue={organization.name} aria-invalid={Boolean(error)} required />
            </Control>
          </SectionRow>
          {/* The org's slug makes this address (learners sign in there); it never changes, so links already sent keep working. */}
          <SectionRow title="Workspace">
            <a href={signInPage} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {signInPage.replace(/^https:\/\/|\/$/g, "")}
            </a>
            <CopyButton value={signInPage} />
          </SectionRow>
          <SectionRow title={<label htmlFor="organization-website">Company website</label>}>
            <Control error={websiteError}>
              <Input
                id="organization-website"
                name="websiteUrl"
                type="url"
                inputMode="url"
                defaultValue={organization.websiteUrl ?? ""}
                placeholder="https://example.com"
                autoComplete="url"
                aria-invalid={Boolean(websiteError)}
              />
            </Control>
          </SectionRow>
          <SectionRow title={<label htmlFor="accent-color">Accent color</label>}>
            <ColorPicker value={accent} onValueChange={(value) => { if (value) setAccent(value); }} format="hex" swatches={ACCENT_SWATCHES}>
              <ColorPickerTrigger id="accent-color" type="button" className="w-40 justify-start font-mono" />
              <ColorPickerContent>
                <ColorPickerPanel />
              </ColorPickerContent>
            </ColorPicker>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAccent(DEFAULT_ACCENT)}>Reset</Button>
          </SectionRow>
        </div>
        <SaveRow saving={saving} saved={saved ? "Organization updated." : null} busyLabel={readingLogo ? "Reading image…" : null} />
      </form>
    </PageSection>
  );
}
