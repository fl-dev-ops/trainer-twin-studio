import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  readWidgetEnd, readWidgetGrant, readWidgetVisitor, widgetEndToken, widgetStartGrant, widgetVisitorToken,
  WIDGET_END_SECONDS, WIDGET_GRANT_SECONDS, WIDGET_VISITOR_SECONDS,
} from "@/lib/widget-tokens";

describe("widget signed capabilities", () => {
  const secret = "widget-token-unit-secret";
  const scope = { orgId: "org-one", agentId: "twin-one", parentOrigin: "https://customer.example", visitorId: "a".repeat(64) };
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = secret;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = previous;
  });
  const signed = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(`widget-v1:${payload}`).digest("base64url")}`;
  };
  const invalid = (read: () => unknown) => {
    expect(read).toThrow(expect.objectContaining({ code: "widget_token_invalid", status: 401 }));
  };

  test("start/end preserve every authority binding; visitor is org/parent scoped", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(readWidgetGrant(widgetStartGrant(scope))).toEqual({ ...scope, kind: "widget-start", expiresAt: now + WIDGET_GRANT_SECONDS });
    expect(readWidgetEnd(widgetEndToken({ ...scope, sessionId: "session-one" }))).toEqual({
      ...scope, sessionId: "session-one", kind: "widget-end", expiresAt: now + WIDGET_END_SECONDS,
    });
    const visitor = { orgId: scope.orgId, parentOrigin: scope.parentOrigin, visitorId: scope.visitorId };
    expect(readWidgetVisitor(widgetVisitorToken(visitor))).toEqual({ ...visitor, kind: "widget-visitor", expiresAt: now + WIDGET_VISITOR_SECONDS });
  });
  test("widget_token_invalid: all token purposes are mutually exclusive", () => {
    const visitor = widgetVisitorToken({ orgId: scope.orgId, parentOrigin: scope.parentOrigin, visitorId: scope.visitorId });
    const start = widgetStartGrant(scope);
    const end = widgetEndToken({ ...scope, sessionId: "session" });
    for (const [read, tokens] of [
      [readWidgetVisitor, [start, end]], [readWidgetGrant, [visitor, end]], [readWidgetEnd, [visitor, start]],
    ] as const) for (const token of tokens) invalid(() => read(token));
  });
  test.each(["orgId", "agentId", "parentOrigin", "visitorId", "expiresAt", "kind"])("widget_token_invalid: unsigned %s tampering", (key) => {
    const token = widgetStartGrant(scope);
    const [payload, signature] = token.split(".");
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    data[key] = key === "expiresAt" ? 9999999999 : "attacker";
    invalid(() => readWidgetGrant(`${Buffer.from(JSON.stringify(data)).toString("base64url")}.${signature}`));
  });
  test.each(["", "bad", "a.b", ".".repeat(2049), "e30." + "a".repeat(43)])("widget_token_invalid: malformed token %s", (token) => {
    invalid(() => readWidgetGrant(token));
  });
  test.each([
    { visitorId: "attacker" }, { expiresAt: 1.2 }, { expiresAt: 0 }, { orgId: "" }, { agentId: "" },
    { extraAuthority: true }, { kind: "widget-end" },
  ])("widget_token_invalid: authenticated malformed payload %j", (change) => {
    invalid(() => readWidgetGrant(signed({ ...scope, kind: "widget-start", expiresAt: Math.floor(Date.now() / 1000) + 60, ...change })));
  });
  test("widget_token_invalid: exact expiry rejected while end capability outlives start", () => {
    const now = Date.now();
    const start = widgetStartGrant(scope);
    const end = widgetEndToken({ ...scope, sessionId: "session" });
    const clock = spyOn(Date, "now").mockReturnValue(now + WIDGET_GRANT_SECONDS * 1000);
    try {
      invalid(() => readWidgetGrant(start));
      expect(readWidgetEnd(end).sessionId).toBe("session");
      clock.mockReturnValue(now + WIDGET_END_SECONDS * 1000);
      invalid(() => readWidgetEnd(end));
    } finally { clock.mockRestore(); }
  });
  test("widget_token_invalid: changing signing secret invalidates existing grants", () => {
    const token = widgetStartGrant(scope);
    process.env.COPILOT_SERVICE_SECRET = "rotated-secret";
    invalid(() => readWidgetGrant(token));
  });
});
