import { z } from "zod";

/** Public call length choices, in seconds (5, 10, 15, 20 and 30 minutes). */
export const PUBLIC_CALL_DURATIONS = [300, 600, 900, 1200, 1800] as const;
export const DEFAULT_PUBLIC_CALL_SECONDS = 300;
/** Durations offered before November 2026; twins still saved with one read as the default instead of failing closed. */
const LEGACY_PUBLIC_CALL_DURATIONS: readonly number[] = [60, 120, 180];

export const publicTwinSettingsSchema = z.object({
  enabled: z.boolean(),
  maxSeconds: z.union([z.literal(300), z.literal(600), z.literal(900), z.literal(1200), z.literal(1800)]),
});
export type PublicTwinSettings = z.infer<typeof publicTwinSettingsSchema>;

const legacySchema = z.object({
  enabled: z.boolean(),
  maxSeconds: z.number().refine((value) => LEGACY_PUBLIC_CALL_DURATIONS.includes(value)),
});

export function publicTwinSettings(data: unknown): PublicTwinSettings {
  const candidate = data && typeof data === "object" && "publicAccess" in data ? data.publicAccess : null;
  const parsed = publicTwinSettingsSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const legacy = legacySchema.safeParse(candidate);
  return { enabled: legacy.success && legacy.data.enabled, maxSeconds: DEFAULT_PUBLIC_CALL_SECONDS };
}

export const publicVisitorNameSchema = z.string().trim().min(1, "Enter your name").max(80, "Use 80 characters or fewer")
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "Use a name without control characters");
