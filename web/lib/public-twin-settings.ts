import { z } from "zod";

export const PUBLIC_CALL_DURATIONS = [60, 120, 180, 300] as const;
export const publicTwinSettingsSchema = z.object({
  enabled: z.boolean(),
  maxSeconds: z.union([z.literal(60), z.literal(120), z.literal(180), z.literal(300)]),
});
export type PublicTwinSettings = z.infer<typeof publicTwinSettingsSchema>;

export function publicTwinSettings(data: unknown): PublicTwinSettings {
  const candidate = data && typeof data === "object" && "publicAccess" in data ? data.publicAccess : null;
  const parsed = publicTwinSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { enabled: false, maxSeconds: 120 };
}

export const publicVisitorNameSchema = z.string().trim().min(1, "Enter your name").max(80, "Use 80 characters or fewer")
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "Use a name without control characters");
