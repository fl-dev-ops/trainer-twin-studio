import assert from "node:assert/strict";
import { portalSlug, signInUrl } from "../lib/base-domain.ts";

assert.equal(portalSlug("careerwithvasanth.trainertwin.localhost:3000"), "careerwithvasanth");
assert.equal(signInUrl("careerwithvasanth.trainertwin.localhost:3000"), "https://auth.trainertwin.localhost:3000/sign-in");
console.log("session user host helpers ok");
