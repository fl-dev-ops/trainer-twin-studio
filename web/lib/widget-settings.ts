import { z } from "zod";

export function normalizeWidgetOrigin(value: string): string | null {
  if (value.length > 300 || !/^https?:\/\/[^/?#\\\s%*@]+$/i.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.protocol === "http:" && !/^http:\/\/(?:localhost|127\.0\.0\.1|(?:[a-z0-9-]+\.)+localhost)(?::[0-9]+)?$/i.test(value)) return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (!hostname.startsWith("[") && (hostname.length > 253 || !hostname.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))) return null;
  return url.origin.length <= 300 ? url.origin : null;
}

const originSchema = z.string().max(300).transform((value, ctx) => {
  const origin = normalizeWidgetOrigin(value);
  if (origin) return origin;
  ctx.addIssue({ code: "custom", message: "Use an exact HTTPS origin without a path, query, wildcard or credentials. HTTP is only allowed for localhost." });
  return z.NEVER;
});

export const widgetSettingsSchema = z.object({
  enabled: z.boolean(),
  allowedOrigins: z.array(originSchema).max(20, "Use at most 20 website origins").transform((origins) => [...new Set(origins)]),
  welcome: z.string().trim().min(1, "Enter a welcome message").max(120)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "Use a welcome message without control characters"),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex colour").transform((value) => value.toLowerCase()),
}).strict().refine((value) => !value.enabled || value.allowedOrigins.length > 0, {
  message: "Add at least one allowed website origin before enabling the widget",
  path: ["allowedOrigins"],
});

export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

export function widgetInstallSnippet(origin: string, id: string, mode: "floating" | "inline"): string {
  const attribute = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return `<script src="${attribute(origin)}/widgets/v1.js" data-twin-id="${attribute(id)}" data-mode="${mode}" referrerpolicy="no-referrer" defer></script>`;
}

export function widgetSettings(data: unknown): WidgetSettings {
  const candidate = data && typeof data === "object" && "widget" in data ? data.widget : null;
  const parsed = widgetSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {
    enabled: false,
    allowedOrigins: [],
    welcome: "Talk to my AI twin",
    accentColor: "#111111",
  };
}
