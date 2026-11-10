import { expect, test } from "bun:test";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { orgHomeUrl, signInUrl, studioUrl } from "@/lib/invite/links";

test("learners sign in on their org's home; admin and team sign in to the studio", () => {
  expect(orgHomeUrl("acme")).toBe(`https://acme.${BASE_DOMAIN}/`);
  expect(studioUrl()).toBe(`https://dash.${BASE_DOMAIN}/`);
  expect(signInUrl("user", "acme")).toBe(orgHomeUrl("acme"));
  expect(signInUrl("team", "acme")).toBe(studioUrl());
  expect(signInUrl("admin", "acme")).toBe(studioUrl());
});
