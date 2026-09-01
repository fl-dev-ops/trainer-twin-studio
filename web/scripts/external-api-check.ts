import assert from "node:assert/strict";
import { externalApiKey } from "../lib/external-api";

assert.equal(externalApiKey(new Request("https://example.com", { headers: { "x-api-key": "tt_header" } })), "tt_header");
assert.equal(externalApiKey(new Request("https://example.com", { headers: { authorization: "Bearer tt_bearer" } })), "tt_bearer");
assert.equal(externalApiKey(new Request("https://example.com")), null);
console.log("external API checks passed");
