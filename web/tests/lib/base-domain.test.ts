import assert from "node:assert/strict";
import test from "node:test";
import { BASE_DOMAIN, safeFamilyRedirect } from "../../lib/base-domain";

test("auth redirects stay inside the TrainerTwin domain family", () => {
  assert.equal(
    safeFamilyRedirect(`https://acme.${BASE_DOMAIN}/s/code`),
    `https://acme.${BASE_DOMAIN}/s/code`,
  );
  assert.equal(safeFamilyRedirect(`https://evil-${BASE_DOMAIN}/s/code`), null);
  assert.equal(safeFamilyRedirect("javascript:alert(1)"), null);
});
