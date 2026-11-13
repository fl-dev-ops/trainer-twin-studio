/**
 * One combined update for a person: membership added, twin/role-play access assigned, and/or learner credits given.
 * Used after those actions commit (People rule 11); a new learner assigned practice gets one email, not one per part.
 */
import { renderEmailLayout } from "./layout";
import { plural } from "./helpers";
import { detailsText, emailButton, emailDetails, emailLink, emailNote, emailParagraph, type EmailDetail } from "./components";

const ROLE_WORDS = { admin: "the admin", team: "a team member", user: "a learner" } as const;

export type PersonEmailArgs = {
  to: string;
  orgName: string;
  /** Who did it ("Olga Sinenko"); "Your trainer" when unknown. */
  byName?: string;
  /** Added to the org just now. `signInUrl`: the org home (learners) or the studio (admin, team). */
  added?: { role: "admin" | "team" | "user"; signInUrl: string };
  /** `until`: the last day they can use it, already formatted ("30 Nov 2026"); none = no end date. */
  twin?: { name: string; url: string; until?: string | null };
  roleplay?: { name: string; url: string; objective?: string; requiredArtifact?: { label: string; prompt: string } | null };
  /** Learner credits (1 credit = 1 minute of practice): `added` just now (if any) and the balance after. */
  credits?: { added?: number; balance: number };
  idempotencyKey?: string;
};

export function personEmail(args: PersonEmailArgs) {
  const by = args.byName?.trim() || "Your trainer";
  const subject = args.twin
    ? `You can now talk to ${args.twin.name}`
    : args.roleplay
      ? `New role play: ${args.roleplay.name}`
      : args.added
        ? `You've been added to ${args.orgName} on TrainerTwin`
        : `${plural(args.credits?.added ?? 0, "credit")} added to your TrainerTwin account`;
  const title = args.twin || args.roleplay ? "Your practice is ready" : args.added ? "Welcome to your workspace" : "Credits added";
  const introduction = args.added
    ? `${by} added you as ${ROLE_WORDS[args.added.role]}.`
    : args.twin || args.roleplay ? `${by} gave you access to new practice.` : `${by} added ${plural(args.credits?.added ?? 0, "credit")}.`;
  const button = args.twin
    ? { label: "Start talking", url: args.twin.url }
    : args.roleplay
      ? { label: "Start practice", url: args.roleplay.url }
      : args.added ? { label: "Sign in", url: args.added.signInUrl } : null;

  const rows: EmailDetail[] = [["Organization", args.orgName]];
  if (args.twin) {
    rows.push(["Twin", args.twin.name]);
    if (args.twin.until) rows.push(["Access until", args.twin.until]);
  }
  if (args.roleplay) {
    rows.push(["Role play", args.roleplay.name]);
    if (args.roleplay.objective) rows.push(["Objective", args.roleplay.objective]);
    if (args.roleplay.requiredArtifact?.prompt) rows.push(["What to bring", args.roleplay.requiredArtifact.prompt]);
  }
  if (args.credits) {
    if (args.credits.added) rows.push(["Credits added", plural(args.credits.added, "credit")]);
    rows.push(["Your balance", plural(args.credits.balance, "credit")]);
  }
  const creditNote = args.credits ? `1 credit = 1 minute of practice.${args.roleplay ? " Repeat practice while your credits last." : ""}` : args.roleplay ? "Repeat practice while your credits last." : "";
  const signIn = button ? `Sign in with Google or an email code using ${args.to}.` : "";
  const otherPractice = args.twin && args.roleplay ? args.roleplay : null;
  return {
    subject,
    html: renderEmailLayout({
      title, previewText: subject,
      contentHtml: emailParagraph(introduction) + emailDetails(rows)
        + (creditNote ? emailNote(creditNote) : "")
        + (signIn ? emailNote(signIn) : "")
        + (button ? emailButton(button.label, button.url) : "")
        + (otherPractice ? emailLink(`Open role play: ${otherPractice.name}`, otherPractice.url) : ""),
    }),
    text: [title, introduction, detailsText(rows), creditNote, signIn, button ? `${button.label}: ${button.url}` : "", otherPractice ? `Open role play: ${otherPractice.name}: ${otherPractice.url}` : ""].filter(Boolean).join("\n\n"),
  };
}
