import { expect, test } from "bun:test";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { AppError, errorResponse, refusedOf, refusals, toAPIError, toTRPCError } from "@/lib/errors";
import { publicProcedure, t } from "@/lib/trpc";
import { isUniqueViolation } from "@/lib/db";
import { ADMIN_ROLE, LEARNER_ROLE, STUDIO_ROLES, TEAM_ROLE, isStudioRole } from "@/lib/roles";

const contracts = [
  ["not_found", 404, "Not found.", refusals.notFound],
  ["signed_out", 401, "Sign in first.", refusals.signedOut],
  ["no_org", 403, "You're not a member of this organization.", refusals.noOrg],
  ["studio_only", 403, "Only the organization's admin and team can do this.", refusals.studioOnly],
  ["org_pin_invalid", 403, "This tab's organization is no longer available to you. Reload the page.", refusals.orgPinInvalid],
  ["member_disabled", 403, "Your access to this organization has been turned off. Ask its admin to turn it back on.", refusals.memberDisabled],
  ["invalid_input", 400, "Enter a name.", () => refusals.invalidInput("Enter a name.")],
] as const;

test.each(contracts)("shared refusal %s keeps exact status/message through REST, Better Auth and workflow data", async (code, status, message, create) => {
  const error = create();
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code, status, message });
  const response = errorResponse(error);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: message, code });
  expect(refusedOf(error)).toEqual({ ok: false, status, error: message, code });
  expect(JSON.parse(JSON.stringify(refusedOf(error)))).toEqual(refusedOf(error));
  expect(toAPIError(error)).toMatchObject({ statusCode: status, body: { message, code } });
});

test.each([
  [400, "BAD_REQUEST"], [401, "UNAUTHORIZED"], [402, "PAYMENT_REQUIRED"], [403, "FORBIDDEN"],
  [404, "NOT_FOUND"], [409, "CONFLICT"], [422, "UNPROCESSABLE_CONTENT"], [429, "TOO_MANY_REQUESTS"],
  [500, "INTERNAL_SERVER_ERROR"], [503, "INTERNAL_SERVER_ERROR"],
] as const)("tRPC conversion of HTTP %i retains its native %s and the refusal as cause", (status, code) => {
  const error = new AppError("custom_refusal", "Exact message.", status);
  expect(toTRPCError(error)).toMatchObject({ code, message: "Exact message.", cause: error });
});

test("serialized tRPC errors keep tRPC data.code and put our code only in data.refusal", async () => {
  const router = t.router({ refused: publicProcedure.query(() => { throw new AppError("person_disabled", "lee@example.com is disabled in this organization. Re-enable them first.", 409); }) });
  const response = await fetchRequestHandler({ endpoint: "/trpc", req: new Request("https://dash.test/trpc/refused"), router, createContext: () => ({ user: null }) });
  expect(response.status).toBe(409);
  const error = (await response.json()).error.json;
  expect(error.message).toBe("lee@example.com is disabled in this organization. Re-enable them first.");
  expect(error.data).toMatchObject({ code: "CONFLICT", httpStatus: 409, refusal: "person_disabled" });
});

test("unknown failures are rethrown unchanged, not flattened to a refusal", () => {
  for (const error of [new Error("Database unavailable"), null, undefined, { code: "P2002" }]) {
    for (const convert of [errorResponse, refusedOf]) {
      let caught: unknown = Symbol("not thrown");
      try { convert(error); } catch (thrown) { caught = thrown; }
      expect(caught).toBe(error);
    }
  }
});

test("only Prisma P2002 is a unique violation, and only admin/team are studio roles", () => {
  expect(isUniqueViolation({ code: "P2002" })).toBe(true);
  for (const error of [null, undefined, "P2002", { code: "P2003" }, new Error("P2002")]) expect(isUniqueViolation(error)).toBe(false);
  expect(STUDIO_ROLES).toEqual([ADMIN_ROLE, TEAM_ROLE]);
  expect(LEARNER_ROLE).toBe("user");
  for (const role of ["admin", "team"]) expect(isStudioRole(role)).toBe(true);
  for (const role of ["user", "owner", "ADMIN", "team,user", "", null, undefined]) expect(isStudioRole(role)).toBe(false);
});
