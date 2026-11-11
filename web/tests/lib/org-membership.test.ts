import { expect, mock, test } from "bun:test";

// People may belong to several orgs; the studio works in one at a time. pickMembership decides which, and a tab's
// pinned org (components/org-pin.tsx) only counts when the person is an enabled studio member there.

type Row = { role: string; organization: { id: string; slug: string; name: string; metadata: null } };
const row = (id: string, role: string): Row => ({ role, organization: { id, slug: id, name: id.toUpperCase(), metadata: null } });
let rows: Row[] = [];
let activeOrganizationId: string | null = null;

mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/auth", () => ({
  auth: { api: { getSession: async () => ({ user: { id: "u1", name: "U", email: "u@example.com" }, session: { activeOrganizationId } }) } },
}));
mock.module("@/lib/db", () => ({ db: { member: { findMany: async () => rows } } }));

const { currentMembership, pickMembership, studioOrgsOf } = await import("@/lib/org");
const { ORG_PIN_HEADER } = await import("@/lib/org-pin");

test("studio memberships first: pinned tab, then active org, then the oldest; learners get active, then oldest", () => {
  const all = [row("learn", "user"), row("a", "team"), row("b", "admin")];
  const org = (pinned?: string | null, active?: string | null) => pickMembership(all, active, pinned)?.organization.id;
  expect(org()).toBe("a"); // oldest studio org, not the older learner one
  expect(org(null, "b")).toBe("b");
  expect(org("a", "b")).toBe("a"); // the tab's own org wins over a switch made in another tab
  expect(org("learn", "b")).toBe("b"); // a learner membership can't be pinned into the studio
  expect(org(null, "learn")).toBe("a"); // nor made active for it
  expect(org("gone", "gone")).toBe("a"); // not (or no longer) a member: ignored
  const learner = [row("x", "user"), row("y", "user")];
  expect(pickMembership(learner, "y")?.organization.id).toBe("y");
  expect(pickMembership(learner)?.organization.id).toBe("x");
  expect(pickMembership([])).toBeNull();
});

test("refuses org_pin_invalid instead of falling back from a stale tab header", async () => {
  rows = [row("a", "admin"), row("b", "team")];
  activeOrganizationId = "a";
  const pinned = (id: string) => new Headers({ [ORG_PIN_HEADER]: id });
  expect((await currentMembership(new Headers()))?.member?.organization.id).toBe("a");
  expect((await currentMembership(pinned("b")))?.member?.organization.id).toBe("b");
  const refused = await currentMembership(pinned("someone-elses"));
  expect(refused?.member).toBeNull();
  expect(refused?.refusal).toMatchObject({ code: "org_pin_invalid", status: 403, message: "This tab's organization is no longer available to you. Reload the page." });
});

test("the switcher lists studio orgs only", async () => {
  rows = [row("learn", "user"), row("a", "admin"), row("b", "team")];
  expect((await studioOrgsOf("u1")).map((org) => org.id)).toEqual(["a", "b"]);
});
