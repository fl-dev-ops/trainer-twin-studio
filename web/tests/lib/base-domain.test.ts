import assert from "node:assert/strict";
import test from "node:test";
import { BASE_DOMAIN, safeFamilyRedirect, signInUrl } from "../../lib/base-domain";

test("auth redirects stay inside the TrainerTwin domain family", () => {
  assert.equal(
    safeFamilyRedirect(`https://acme.${BASE_DOMAIN}/s/code`),
    `https://acme.${BASE_DOMAIN}/s/code`,
  );
  assert.equal(safeFamilyRedirect(`https://evil-${BASE_DOMAIN}/s/code`), null);
  assert.equal(safeFamilyRedirect(`https://${BASE_DOMAIN}.attacker.test/s/code`), null);
  assert.equal(safeFamilyRedirect("javascript:alert(1)"), null);
});

test("learner sign-in preserves the assignment link across authentication", () => {
  const url = new URL(signInUrl(`careerwithvasanth.${BASE_DOMAIN}`, "/s/learner-code"));
  assert.equal(url.hostname, `auth.${BASE_DOMAIN}`);
  assert.equal(url.searchParams.get("redirect"), `https://careerwithvasanth.${BASE_DOMAIN}/s/learner-code`);
  assert.equal(safeFamilyRedirect(url.searchParams.get("redirect") ?? undefined), url.searchParams.get("redirect"));
});
