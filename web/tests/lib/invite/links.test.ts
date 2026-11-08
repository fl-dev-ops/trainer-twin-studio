import { expect, test } from "bun:test";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { learnerInviteUrl, orgInviteUrl, teamInviteUrl } from "@/lib/invite/links";

test("a learner's invite opens their org's home page; a studio invite opens the auth invite page", () => {
  expect(orgInviteUrl({ id: "inv1", role: "user" }, "olga")).toBe(`https://olga.${BASE_DOMAIN}/`);
  expect(orgInviteUrl({ id: "inv1", role: "team" }, "olga")).toBe(`https://auth.${BASE_DOMAIN}/invite?token=inv1`);
  expect(orgInviteUrl({ id: "a b", role: "admin" }, "olga")).toBe(teamInviteUrl("a b"));
  expect(teamInviteUrl("a b")).toBe(`https://auth.${BASE_DOMAIN}/invite?token=a%20b`);
  expect(learnerInviteUrl("acme")).toBe(`https://acme.${BASE_DOMAIN}/`);
});
