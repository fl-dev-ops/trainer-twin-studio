import { describe, expect, test } from "bun:test";
import { normalizeWidgetOrigin, widgetInstallSnippet, widgetSettings, widgetSettingsSchema } from "@/lib/widget-settings";

const defaults = { enabled: false, allowedOrigins: [], welcome: "Talk to my AI twin", accentColor: "#111111" };

describe("widget settings", () => {
  test.each([undefined, null, {}, { widget: null }, { widget: { enabled: true } }, { widget: { ...defaults, enabled: true } }])("fails closed for invalid stored data %j", (data) => {
    expect(widgetSettings(data)).toEqual(defaults);
  });
  test.each([
    ["https://EXAMPLE.com:443", "https://example.com"],
    ["https://example.com:8443", "https://example.com:8443"],
    ["http://LOCALHOST:80", "http://localhost"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://studio.localhost:3000", "http://studio.localhost:3000"],
  ])("normalizes exact origin %s", (value, normalized) => {
    expect(normalizeWidgetOrigin(value)).toBe(normalized);
  });
  test.each([
    "https://*.example.com", "https://example.com/", "https://example.com/path", "https://example.com?x=1",
    "https://example.com?", "https://example.com#x", "https://example.com#", "https://user@example.com",
    "https://user:password@example.com", "https://example.com\\evil", "https://exa mple.com", "https://example.com\n",
    "https://example%2ecom", "http://example.com", "http://localhost.example.com", "http://127.0.0.2", "http://127.1", "http://0x7f000001",
    "javascript:alert(1)", "file:///etc/passwd", "null", "https://foo..example", "https://-example.com",
  ])("rejects unsafe or non-exact origin %s", (value) => {
    expect(normalizeWidgetOrigin(value)).toBeNull();
  });
  test("normalizes and deduplicates origins while retaining ports", () => {
    expect(widgetSettingsSchema.parse({ ...defaults, enabled: true, accentColor: "#ABCDEF", allowedOrigins: [
      "https://EXAMPLE.com:443", "https://example.com", "https://example.com:8443",
    ] })).toEqual({ ...defaults, enabled: true, accentColor: "#abcdef", allowedOrigins: ["https://example.com", "https://example.com:8443"] });
  });
  test("caps the allowlist even when repeated", () => {
    expect(widgetSettingsSchema.safeParse({ ...defaults, allowedOrigins: Array(21).fill("https://example.com") }).success).toBe(false);
  });
  test("caps origins before and after normalization", () => {
    expect(normalizeWidgetOrigin(`https://${"a".repeat(290)}.example.com`)).toBeNull();
    expect(widgetSettingsSchema.safeParse({ ...defaults, allowedOrigins: [`https://${"a".repeat(290)}.example.com`] }).success).toBe(false);
    expect(normalizeWidgetOrigin(`https://${"é".repeat(60)}.${"é".repeat(60)}.${"é".repeat(60)}.${"é".repeat(60)}.com`)).toBeNull();
  });
  test("requires an origin to enable, independently of public access", () => {
    expect(widgetSettingsSchema.safeParse({ ...defaults, enabled: true }).success).toBe(false);
    expect(widgetSettings({ publicAccess: { enabled: true }, widget: defaults })).toEqual(defaults);
    expect(widgetSettings({ publicAccess: { enabled: false }, widget: { ...defaults, enabled: true, allowedOrigins: ["https://example.com"] } }).enabled).toBe(true);
  });
  test("bounds welcome and allows only safe six-digit colours", () => {
    expect(widgetSettingsSchema.safeParse({ ...defaults, welcome: "   " }).success).toBe(false);
    expect(widgetSettingsSchema.safeParse({ ...defaults, welcome: "Hello\u0007there" }).success).toBe(false);
    expect(widgetSettingsSchema.safeParse({ ...defaults, welcome: "a".repeat(120) }).success).toBe(true);
    expect(widgetSettingsSchema.safeParse({ ...defaults, welcome: "a".repeat(121) }).success).toBe(false);
    for (const accentColor of ["red", "#fff", "#12345678", "url(https://example.com)", "#12345g"]) {
      expect(widgetSettingsSchema.safeParse({ ...defaults, accentColor }).success).toBe(false);
    }
  });
  test("snippets use org-host assets, floating mode and escaped attributes only", () => {
    expect(widgetInstallSnippet("https://acme.example.com", "cm123")).toBe('<script src="https://acme.example.com/widgets/v1.js" data-twin-id="cm123" data-mode="floating" referrerpolicy="no-referrer" defer></script>');
    expect(widgetInstallSnippet("https://acme.example.com", '"><script>&\'')).toContain('data-twin-id="&quot;&gt;&lt;script&gt;&amp;&#39;"');
  });
});
