import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { load } from "js-yaml";

type Schema = { type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; oneOf?: Schema[]; not?: Schema; maxLength?: number; $ref?: string };
type Operation = { operationId?: string; parameters?: { $ref?: string }[]; responses?: Record<string, unknown>; requestBody?: { content: { "application/json": { schema: Schema } } } };
const root = resolve(import.meta.dir, "../../..");
const spec = load(readFileSync(join(root, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; parameters: Record<string, { required?: boolean; schema: Schema }> };
};
const normalized = (path: string) => path.replace(/\{[^}]+\}|\[[^\]]+\]/g, "{id}");
const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
  .filter(([, operation]) => operation.operationId)
  .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name === "route.ts" ? [path] : [];
  });
}

test("OpenAPI covers every public v1 resource method, excluding the separate model-call transport", () => {
  const routes = join(root, "web/app/api/v1");
  const actual = files(routes).filter((file) => !relative(routes, file).startsWith("chat/"))
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/export\s+(?:const|async\s+function)\s+(GET|POST|PATCH|DELETE|PUT)\b/g)]
      .map((match) => `${match[1]} /${normalized(relative(routes, file).replace(/\/route\.ts$/, ""))}`));
  expect(operations.map(({ method, path }) => `${method} ${normalized(path)}`).sort()).toEqual(actual.sort());
});

test("every documented operation declares auth, permission, rate-limit and generic server errors", () => {
  for (const { operation } of operations) {
    for (const status of ["401", "403", "429", "500"]) expect(operation.responses).toHaveProperty(status);
  }
  expect(spec.components.schemas.Error.required).toEqual(["error", "code"]);
});

test("credit grants require an idempotency header, use the documented minutes input and declare replay/conflict", () => {
  const operation = spec.paths["/users/{userId}/credits"].post;
  expect(operation.parameters).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
  expect(spec.components.parameters.IdempotencyKey).toMatchObject({ required: true, schema: { type: "string", maxLength: 128 } });
  expect(operation.requestBody?.content["application/json"].schema.required).toEqual(["minutes"]);
  for (const status of ["200", "201", "400", "404", "409"]) expect(operation.responses).toHaveProperty(status);
  expect(spec.components.schemas.CreditGrantResult.required).toContain("grant");
  expect(spec.components.schemas.CreditGrantResult.required).toContain("created");
});

test("assignment schemas reject both recipient identifiers rather than choosing different precedence", () => {
  expect(spec.components.schemas.AssignmentTarget.oneOf).toEqual([{ required: ["userId"] }, { required: ["email"] }]);
  expect(spec.paths["/assignments/{assignmentId}"].patch.requestBody?.content["application/json"].schema.not).toEqual({ required: ["email", "userId"] });
});

type Item = { item?: Item[]; request?: { method: string; url: string; header?: { key: string; value: string }[] } };
const collection = JSON.parse(readFileSync(join(root, "docs/trainer-twin-api.postman_collection.json"), "utf8")) as { item: Item[] };
const requests = (items: Item[]): NonNullable<Item["request"]>[] => items.flatMap((item) => item.request ? [item.request] : requests(item.item ?? []));

test.each([
  { api: "https://dash.trainertwin.com/api/v1", database: "postgresql://test:test@127.0.0.1:1/example_test" },
  { api: "http://localhost:3999/api/v1", database: "postgresql://test:test@127.0.0.1:1/development" },
  { api: "http://localhost:3999/api/v1", database: "postgresql://test:test@db.example.invalid:5432/example_test" },
])("the HTTP contract checker refuses non-test targets before fixture writes ($api, $database)", async ({ api, database }) => {
  const child = Bun.spawn([process.execPath, "scripts/api-contract-check.ts"], {
    cwd: join(root, "web"), env: { ...process.env, API_BASE: api, DATABASE_URL: database, DATABASE_URL_UNPOOLED: database }, stdout: "pipe", stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect(status).not.toBe(0);
  expect(stderr).toContain("refusing: use a localhost API and its localhost *_test database");
});

test("Postman covers the same operations and retains one explicit request key across credit retries", () => {
  const all = requests(collection.item);
  const paths = new Set(all.map((request) => `${request.method} ${normalized(request.url.replace("{{baseUrl}}", "").split("?")[0].replace(/\{\{(\w+)\}\}/g, "{$1}"))}`));
  expect([...paths].sort()).toEqual(operations.map(({ method, path }) => `${method} ${normalized(path)}`).sort());
  const grant = all.find((request) => request.method === "POST" && request.url.endsWith("/credits"));
  expect(grant?.header).toContainEqual({ key: "Idempotency-Key", value: "{{creditRequestKey}}" });
});
