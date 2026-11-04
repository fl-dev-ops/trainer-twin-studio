import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Settings and form pages (twin Configure, role-play builder) as separate cards instead of one card with dividers:
 * a section heading, then one card per setting or per group of fields.
 */

/** The page panel a settings tab sits in (the studio's top-level card): sections of nested setting cards inside. */
export function SettingsPanel({ children }: { children: ReactNode }) {
  return (
    <Card size="lg">
      <CardContent className="flex flex-col gap-6">{children}</CardContent>
    </Card>
  );
}

/** A section heading with the cards that belong to it. */
export function SettingsSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        {description ? <p className="m-0 mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** One setting: title, what it does, its control (a switch) on the right, and any fields it opens below. */
export function SettingCard({ title, description, control, children }: { title: string; description: ReactNode; control: ReactNode; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>{control}</CardAction>
      </CardHeader>
      {children ? <CardContent className="flex flex-col gap-3">{children}</CardContent> : null}
    </Card>
  );
}

/** A group of form fields: title, a line on what it's for, the fields. */
export function FormCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card size="lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}
