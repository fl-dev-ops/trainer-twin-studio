import { expect, test } from "bun:test";
import { orgCreditsEmail, personEmail } from "@/lib/email";
import { lastDay, personEmailFor } from "@/lib/invite/person-email";
import { orgHomeUrl, studioUrl } from "@/lib/invite/links";
import type { AddedPerson } from "@/lib/org-people";

// specs/people.md rule 11: one email per person per action, combining what applies.

const base = { to: "lee@example.com", orgName: "Acme", byName: "Olga" };
const twin = { name: "Olga's twin", url: "https://acme.example.com/t/olga", until: "30 Nov 2026" };
const roleplay = { name: "Cold call", url: "https://acme.example.com/s/code", objective: "Book a meeting", requiredArtifact: { label: "Notes", prompt: "Bring your call notes" } };
const added = { role: "user" as const, signInUrl: "https://acme.example.com/" };

test("added only: subject, who/org/role, how to sign in, and a Sign in button to the given link", () => {
  for (const [role, words, url] of [["user", "a learner", orgHomeUrl("acme")], ["team", "a team member", studioUrl()], ["admin", "the admin", studioUrl()]] as const) {
    const { subject, html, text } = personEmail({ ...base, added: { role, signInUrl: url } });
    expect(subject).toBe("You've been added to Acme on TrainerTwin");
    expect(html).toContain(`<strong>Olga</strong> added you to <strong>Acme</strong> on TrainerTwin as ${words}.`);
    expect(text).toContain(`Olga added you to Acme on TrainerTwin as ${words}.`);
    expect(html).toContain(">Sign in</a>");
    expect(html).toContain(`href="${url}"`);
    expect(text).toContain(`Sign in with Google or an email code, using lee@example.com: ${url}`);
    expect(html).not.toMatch(/password/i);
  }
});

test("a brand-new learner given a twin gets ONE email: added + twin (until) + credits, button opens the twin", () => {
  const { subject, html, text } = personEmail({ ...base, added, twin, credits: { added: 30, balance: 30 } });
  expect(subject).toBe("You can now talk to Olga's twin");
  expect(html).toContain("added you to <strong>Acme</strong>");
  expect(html).toContain("can now talk to <strong>Olga&#39;s twin</strong>");
  expect(html).toContain("You can use it until 30 Nov 2026.");
  expect(html).toContain("You have <strong>30 credits</strong>. Your balance is <strong>30 credits</strong>");
  expect(html).toContain(">Start talking</a>");
  expect(html).toContain(`href="${twin.url}"`);
  expect(html).not.toContain(">Sign in</a>");
  expect(text).toContain("You can now talk to Olga's twin. Until 30 Nov 2026.");
  expect(text).toContain("30 credits added. Your balance: 30 credits");
});

test.each([
  { parts: { twin, roleplay, added, credits: { added: 30, balance: 30 } }, subject: "You can now talk to Olga's twin", url: twin.url, label: "Start talking" },
  { parts: { roleplay, added, credits: { added: 30, balance: 30 } }, subject: "New role play: Cold call", url: roleplay.url, label: "Start practice" },
  { parts: { added, credits: { added: 30, balance: 30 } }, subject: "You've been added to Acme on TrainerTwin", url: added.signInUrl, label: "Sign in" },
])("combined parts choose subject/button in priority order: $label", ({ parts, subject, url, label }) => {
  const email = personEmail({ ...base, ...parts });
  expect(email.subject).toBe(subject);
  expect(email.html.match(/class="btn"/g)).toHaveLength(1);
  expect(email.html).toContain(`href="${url}" class="btn"`);
  expect(email.html).toContain(`>${label}</a>`);
  expect(email.text).toContain(`using ${base.to}: ${url}`);
});

test("regression: role-play objective also appears in the plain-text email", () => {
  expect(personEmail({ ...base, added, roleplay, credits: { added: 30, balance: 30 } }).text).toContain(roleplay.objective);
});

test("twin for an existing learner: 'gave you access', no added line, no end date when none", () => {
  const { html, text } = personEmail({ ...base, twin: { name: "T", url: "https://x/t" }, credits: { balance: 1 } });
  expect(html).toContain("<strong>Olga</strong> gave you access to <strong>T</strong>");
  expect(html).not.toContain("added you to");
  expect(html).not.toContain("until");
  expect(html).toContain("Your balance is <strong>1 credit</strong>");
  expect(text).not.toContain("credits added");
});

test("role play: objective, what to bring, credits and a Start practice button", () => {
  const { subject, html, text } = personEmail({ ...base, roleplay, credits: { balance: 12 } });
  expect(subject).toBe("New role play: Cold call");
  expect(html).toContain("<strong>Olga</strong> gave you the role play <strong>Cold call</strong>");
  expect(html).toContain("&ldquo;Book a meeting&rdquo;");
  expect(html).toContain("Bring your call notes");
  expect(html).toContain(">Start practice</a>");
  expect(text).toContain("What to bring: Bring your call notes.");
  expect(text).toContain(`using lee@example.com: ${roleplay.url}`);
});

test("credits only: subject says how many, body the new balance; no button", () => {
  const { subject, html, text } = personEmail({ ...base, credits: { added: 1, balance: 41 } });
  expect(subject).toBe("1 credit added to your TrainerTwin account");
  expect(html).toContain("<strong>Olga</strong> added <strong>1 credit</strong> to your account.");
  expect(html).toContain("Your balance is <strong>41 credits</strong>");
  expect(html).not.toContain('class="btn"');
  expect(text).toBe("1 credit added. Your balance: 41 credits (1 credit = 1 minute of practice).");
});

test("no byName: 'Your trainer'; every value is escaped in HTML and raw in text", () => {
  const evil = '<b>&"x"</b>';
  const { subject, html, text } = personEmail({ to: 'a&"b"@example.com', orgName: evil, added: { role: "user", signInUrl: "https://x/" }, roleplay: { ...roleplay, url: "https://x/?a=1&b=2", name: evil, objective: evil } });
  expect(html).not.toContain(evil);
  expect(html).toContain("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
  expect(html).toContain("<strong>Your trainer</strong> added you");
  expect(html).toContain('href="https://x/?a=1&amp;b=2"');
  expect(html).toContain("a&amp;&quot;b&quot;@example.com");
  expect(subject).toBe(`New role play: ${evil}`);
  expect(text).toContain(evil);
});

test("org credits email to the admin: how many, reason, expiry, new balance, link", () => {
  const { subject, html, text } = orgCreditsEmail({ to: "admin@x.com", orgName: "Acme", added: 500, balance: 620, expires: "10 Nov 2027", reason: "Pack <A>", creditsUrl: "https://dash.x/credits" });
  expect(subject).toBe("500 credits added to Acme");
  expect(html).toContain("(Pack &lt;A&gt;)");
  expect(html).toContain("They expire on 10 Nov 2027.");
  expect(html).toContain("balance is now <strong>620 credits</strong>");
  expect(html).toContain('href="https://dash.x/credits"');
  expect(text).toBe("500 credits added to Acme (Pack <A>). They expire on 10 Nov 2027. New balance: 620 credits. https://dash.x/credits");
  expect(orgCreditsEmail({ to: "a", orgName: "O", added: 1, balance: 1, creditsUrl: "u" }).text).toBe("1 credit added to O. New balance: 1 credit. u");
});

const person = (fields: Partial<AddedPerson> = {}): AddedPerson => ({
  memberId: "m1", userId: "u1", name: "Lee", email: "lee@example.com", image: null, role: "user",
  disabled: false, disabledAt: null, addedAt: new Date(), added: false, startingCredits: 0, ...fields,
});
const org = { slug: "acme", name: "Acme" };

test("personEmailFor: 'added' only for people who joined just now, with the sign-in link for their role", () => {
  expect(personEmailFor({ person: person(), org, by: { name: "Olga" }, key: "k" })).toEqual({
    kind: "person", idempotencyKey: "k", args: { to: "lee@example.com", orgName: "Acme", byName: "Olga" },
  });
  expect(personEmailFor({ person: person({ added: true }), org, by: { name: "Olga" }, key: "added:m1" }).args.added).toEqual({ role: "user", signInUrl: orgHomeUrl("acme") });
  expect(personEmailFor({ person: person({ added: true, role: "team" }), org, by: { name: "Olga" }, key: "added:m1" }).args.added).toEqual({ role: "team", signInUrl: studioUrl() });
});

test("personEmailFor: credits only with a balance; starting credits count as added unless said otherwise", () => {
  const p = person({ added: true, startingCredits: 30 });
  expect(personEmailFor({ person: p, org, by: { name: "O" }, key: "k" }).args).not.toHaveProperty("credits");
  expect(personEmailFor({ person: p, org, by: { name: "O" }, key: "k", balance: 30 }).args.credits).toEqual({ added: 30, balance: 30 });
  expect(personEmailFor({ person: person(), org, by: { name: "O" }, key: "k", balance: 7 }).args.credits).toEqual({ added: undefined, balance: 7 });
  expect(personEmailFor({ person: p, org, by: { name: "O" }, key: "k", balance: 50, creditsAdded: 20 }).args.credits).toEqual({ added: 20, balance: 50 });
});

test("lastDay: the chosen day for an end-of-day date, null for none", () => {
  expect(lastDay(null)).toBeNull();
  expect(lastDay(undefined)).toBeNull();
  // End of 30 Nov in UTC+5:30 is 18:29:59Z on 30 Nov; in UTC−8 it is 07:59:59Z on 1 Dec.
  expect(lastDay(new Date("2026-11-30T18:29:59Z"))).toBe("30 Nov 2026");
  expect(lastDay(new Date("2026-12-01T07:59:59Z"))).toBe("30 Nov 2026");
});
