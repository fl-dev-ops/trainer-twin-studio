/**
 * Public API contract check: calls every endpoint in docs/openapi.yaml against a running web server and validates
 * each response (status and body) against the documented schema. Fields the docs don't mention are reported too.
 *
 *   ORG=e2e bun --preload ./e2e/use-test-db.ts scripts/api-contract-check.ts
 *
 * Run the isolated e2e server and seed first. Requires its localhost *_test database and local fake Meteroid, never
 * a production wallet. Makes a throwaway key/learners/assignments and cleans their rows afterward. Seed afresh before
 * another run: the fake wallet may already have counted their credit events. Development suppresses real email.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks the untyped YAML document
type Schema = Record<string, any>;
const spec = load(readFileSync(new URL("../../docs/openapi.yaml", import.meta.url), "utf8")) as Schema;
const API = process.env.API_BASE ?? "http://localhost:3999/api/v1";
const ORG = process.env.ORG ?? "e2e";
const local = (host: string) => host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (!local(new URL(API).hostname) || !databaseUrl || !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith("_test")) {
  throw new Error("refusing: use a localhost API and its localhost *_test database");
}

// ---- A small validator for the JSON Schema subset the spec uses ---------------------------------------------------
const resolve = (schema: Schema): Schema =>
  schema.$ref ? resolve(schema.$ref.slice(2).split("/").reduce((node: Schema, key: string) => node[key], spec)) : schema;

function validate(value: unknown, raw: Schema, path: string, errors: string[], extras: string[]) {
  const schema = resolve(raw);
  if (schema.allOf) {
    const merged: Schema = { type: "object", required: [], properties: {} };
    for (const part of schema.allOf.map(resolve)) {
      merged.required.push(...(part.required ?? []));
      Object.assign(merged.properties, part.properties ?? {});
    }
    return validate(value, merged, path, errors, extras);
  }
  const types: string[] = schema.type ? [schema.type].flat() : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    errors.push(`${path}: expected ${types.join("|")}, got ${actual} (${JSON.stringify(value)?.slice(0, 60)})`);
    return;
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (schema.format === "date-time" && typeof value === "string" && Number.isNaN(Date.parse(value))) errors.push(`${path}: not a date-time`);
  if (schema.format === "uri" && typeof value === "string" && !URL.canParse(value)) errors.push(`${path}: not a URI`);
  if (actual === "array" && schema.items) (value as unknown[]).forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors, extras));
  if (actual === "object" && (schema.properties || schema.required)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: required but missing`);
    for (const [key, child] of Object.entries(object)) {
      const declared = schema.properties?.[key];
      if (declared) validate(child, declared, `${path}.${key}`, errors, extras);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else extras.push(`${path}.${key}`);
    }
  }
}

// ---- Calls -------------------------------------------------------------------------------------------------------
let apiKey = "";
const results: { name: string; ok: boolean; notes: string[] }[] = [];

/** One documented call: checks the status is documented for that operation and the body matches its schema. */
async function call(name: string, method: string, template: string, path: string, expected: number, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(headers ?? { "x-api-key": apiKey }), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  const notes: string[] = [];
  const errors: string[] = [];
  const extras: string[] = [];
  if (response.status !== expected) errors.push(`status ${response.status}, expected ${expected}: ${text.slice(0, 200)}`);
  const documented = spec.paths[template]?.[method.toLowerCase()]?.responses?.[String(response.status)];
  if (!documented) errors.push(`status ${response.status} is not documented for ${method} ${template}`);
  else {
    const responseSchema = resolve(documented).content?.["application/json"]?.schema;
    if (responseSchema) validate(json, responseSchema, "body", errors, extras);
    else if (text) errors.push("documented without a body, but one was returned");
  }
  if (extras.length) notes.push(`undocumented fields: ${[...new Set(extras.map((e) => e.replace(/\[\d+\]/g, "[]")))].join(", ")}`);
  results.push({ name: `${method} ${path} → ${response.status}  (${name})`, ok: errors.length === 0, notes: [...errors, ...notes] });
  return json;
}

// ---- Fixtures ----------------------------------------------------------------------------------------------------
const org = await db.organization.findUniqueOrThrow({ where: { slug: ORG }, select: { id: true } });
const trainer = await db.member.findFirstOrThrow({ where: { organizationId: org.id, role: { in: ["admin", "team"] } }, select: { userId: true } });
const scenarios = await db.agent.findMany({ where: { orgId: org.id, kind: "ROLEPLAY", archivedAt: null }, orderBy: { order: "asc" }, take: 2, select: { slug: true } });
const outsider = await db.member.findFirst({ where: { organizationId: { not: org.id }, role: "user" }, select: { userId: true } });
assert.ok(scenarios.length > 0, `${ORG} needs a published role play`);
const run = randomUUID().slice(0, 8);
const learnerEmail = `api-contract-${run}@example.com`;
const inviteEmail = `api-invite-${run}@example.com`;
const learner = await db.user.create({ data: { id: `apicheck_${run}`, name: "Contract Learner", email: learnerEmail, emailVerified: true } });
await db.member.create({ data: { id: `apicheck_m_${run}`, organizationId: org.id, userId: learner.id, role: "user", createdAt: new Date() } });
const created = await auth.api.createApiKey({ body: { name: `contract-check-${run}`, organizationId: org.id, userId: trainer.userId, metadata: { createdByUserId: trainer.userId } } });
apiKey = created.key;

try {
  // Authentication
  await call("no key", "GET", "/users", "/users", 401, undefined, {});
  await call("wrong key", "GET", "/users", "/users", 401, undefined, { "x-api-key": "tt_wrong" });
  await call("bearer key", "GET", "/users", "/users?limit=1", 200, undefined, { authorization: `Bearer ${apiKey}` });
  await call("bad pagination", "GET", "/users", "/users?limit=0", 400);

  // Scenarios
  await call("list", "GET", "/scenarios", "/scenarios", 200);
  await call("detail", "GET", "/scenarios/{scenarioSlug}", `/scenarios/${scenarios[0].slug}`, 200);
  await call("unknown", "GET", "/scenarios/{scenarioSlug}", "/scenarios/no-such-scenario", 404);

  // Users
  const users = await call("list", "GET", "/users", "/users?limit=100", 200);
  assert.ok(users.users.some((u: { id: string }) => u.id === learner.id), "the new learner is listed");
  await call("detail", "GET", "/users/{userId}", `/users/${learner.id}`, 200);
  await call("rename", "PATCH", "/users/{userId}", `/users/${learner.id}`, 200, { name: "Contract Learner 2" });
  await call("rename, empty", "PATCH", "/users/{userId}", `/users/${learner.id}`, 400, { name: "" });
  // Adding someone makes them a learner of the org right away (specs/people.md); adding them again changes nothing.
  await call("add", "POST", "/users", "/users", 201, { email: inviteEmail });
  await call("add again", "POST", "/users", "/users", 200, { email: inviteEmail });
  await call("add an existing learner", "POST", "/users", "/users", 200, { email: learnerEmail });
  await call("add, bad email", "POST", "/users", "/users", 400, { email: "nope" });
  if (outsider) await call("other org's user", "GET", "/users/{userId}", `/users/${outsider.userId}`, 404);

  // Credits: original keys keep using users permissions, and the request identity survives retries.
  await call("org credits", "GET", "/credits", "/credits", 200);
  await call("learner credits", "GET", "/users/{userId}/credits", `/users/${learner.id}/credits`, 200);
  const creditHeaders = { "x-api-key": apiKey, "Idempotency-Key": `contract-${run}` };
  const grantPath = `/users/${learner.id}/credits`;
  const grantBody = { minutes: 10, note: "Contract check" };
  const granted = await call("grant", "POST", "/users/{userId}/credits", grantPath, 201, grantBody, creditHeaders);
  const replayed = await call("grant replay", "POST", "/users/{userId}/credits", grantPath, 200, grantBody, creditHeaders);
  assert.equal(replayed.grant.id, granted.grant.id);
  assert.equal(replayed.created, false);
  await call("grant conflict", "POST", "/users/{userId}/credits", grantPath, 409, { ...grantBody, minutes: 11 }, creditHeaders);
  await call("grant key required", "POST", "/users/{userId}/credits", grantPath, 400, grantBody);

  // Assignments
  const first = await call("create", "POST", "/assignments", "/assignments", 201, { userId: learner.id, scenario: scenarios[0].slug });
  const id = first.assignment.id as string;
  await call("create again (idempotent)", "POST", "/assignments", "/assignments", 200, { userId: learner.id, scenario: scenarios[0].slug });
  await call("unknown scenario", "POST", "/assignments", "/assignments", 404, { userId: learner.id, scenario: "no-such-scenario" });
  if (outsider) await call("other org's user", "POST", "/assignments", "/assignments", 404, { userId: outsider.userId, scenario: scenarios[0].slug });
  const list = await call("list by learner", "GET", "/assignments", `/assignments?userId=${learner.id}`, 200);
  assert.equal(list.assignments[0]?.user?.id, learner.id, "an assignment made by userId names its learner before they open it");
  await call("detail", "GET", "/assignments/{assignmentId}", `/assignments/${id}`, 200);
  await call("no-op update", "PATCH", "/assignments/{assignmentId}", `/assignments/${id}`, 200, { scenario: scenarios[0].slug });
  let unusedId = id;
  if (scenarios[1]) {
    const moved = await call("move to another scenario", "PATCH", "/assignments/{assignmentId}", `/assignments/${id}`, 200, { scenario: scenarios[1].slug });
    unusedId = moved.assignment.id;
    await call("move retry", "PATCH", "/assignments/{assignmentId}", `/assignments/${id}`, 200, { scenario: scenarios[1].slug });
    await call("closed source stays", "DELETE", "/assignments/{assignmentId}", `/assignments/${id}`, 404);
  }
  await call("ambiguous recipient", "POST", "/assignments", "/assignments", 400, { userId: learner.id, email: learnerEmail, scenario: scenarios[0].slug });
  await call("empty update", "PATCH", "/assignments/{assignmentId}", `/assignments/${id}`, 400, {});
  await call("delete unused", "DELETE", "/assignments/{assignmentId}", `/assignments/${unusedId}`, 204);
  await call("deleted", "GET", "/assignments/{assignmentId}", `/assignments/${unusedId}`, 404);

  // Sessions
  const sessions = await call("list", "GET", "/sessions", "/sessions?limit=20", 200);
  await call("filtered", "GET", "/sessions", "/sessions?status=completed&from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z", 200);
  await call("bad filter", "GET", "/sessions", "/sessions?status=bogus", 400);
  await call("closing filter", "GET", "/sessions", "/sessions?status=closing", 200);
  await call("reversed dates", "GET", "/sessions", "/sessions?from=2030-01-01T00:00:00Z&to=2026-01-01T00:00:00Z", 400);
  if (sessions.sessions[0]) await call("detail", "GET", "/sessions/{sessionId}", `/sessions/${sessions.sessions[0].id}`, 200);
  await call("unknown", "GET", "/sessions/{sessionId}", "/sessions/no-such-session", 404);

  // Removing a learner
  await call("remove", "DELETE", "/users/{userId}", `/users/${learner.id}`, 204);
  await call("remove again", "DELETE", "/users/{userId}", `/users/${learner.id}`, 204);
  await call("removed", "GET", "/users/{userId}", `/users/${learner.id}`, 404);
} finally {
  await db.apikey.deleteMany({ where: { id: created.id } });
  await db.rolePlayAssignment.deleteMany({ where: { orgId: org.id, member: { user: { email: { in: [learnerEmail, inviteEmail] } } } } });
  // Remove fixture ledger rows; reseed the local fake wallet before another check.
  await db.minuteLedger.deleteMany({ where: { orgId: org.id, email: { in: [learnerEmail, inviteEmail] } } });
  await db.session.deleteMany({ where: { userId: learner.id } });
  await db.member.deleteMany({ where: { organizationId: org.id, user: { email: { in: [learnerEmail, inviteEmail] } } } });
  await db.user.deleteMany({ where: { email: { in: [learnerEmail, inviteEmail] } } });
}

for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}`);
  for (const note of result.notes) console.log(`       ${note}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} calls match docs/openapi.yaml`);
process.exit(failed ? 1 : 0);
