import assert from "node:assert/strict";
import { z } from "zod";

// Mirrors the query schema in app/api/v1/sessions/route.ts.
const querySchema = z.object({
  status: z.enum(["active", "completed", "abandoned"]).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict();

const valid = querySchema.safeParse({
  from: "2026-09-01T00:00:00Z",
  to: "2026-09-30T23:59:59+05:30",
});
assert.equal(valid.success, true);

assert.equal(querySchema.safeParse({ from: "not-a-date" }).success, false);
assert.equal(querySchema.safeParse({ from: "2026-13-01" }).success, false);
assert.equal(querySchema.safeParse({ userId: "u1" }).success, true);

// startedAt range merge, as in the route handler.
const startedAtRange = [
  valid.success && valid.data.from ? { gte: new Date(valid.data.from) } : {},
  valid.success && valid.data.to ? { lte: new Date(valid.data.to) } : {},
].filter((range) => Object.keys(range).length > 0);
assert.deepEqual(Object.assign({}, ...startedAtRange), {
  gte: new Date("2026-09-01T00:00:00Z"),
  lte: new Date("2026-09-30T23:59:59+05:30"),
});

console.log("session filter checks passed");
