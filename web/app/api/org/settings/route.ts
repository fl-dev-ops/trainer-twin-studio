import { z } from "zod";
import { errorResponse, refusals } from "@/lib/errors";
import { studioOrg, updateOrgSettings } from "@/lib/org";

const httpsOrEmpty = z.string().trim().max(2048, "Enter a website URL up to 2048 characters.").refine((value) => {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Enter a valid HTTPS website URL.");

const bodySchema = z.object({
  name: z.string().trim().min(1, "Enter an organization name.").max(80, "Use an organization name up to 80 characters."),
  logo: z.string().nullable(),
  accentColor: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "Choose an accent colour like #EC3013."),
  websiteUrl: httpsOrEmpty,
}).strict();

/** The org's branding, saved in one request (specs/people.md rule 21). Studio only. */
export async function PATCH(request: Request) {
  try {
    const org = await studioOrg();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw refusals.invalidInput(parsed.error.issues[0]?.message ?? "Send name, logo, accentColor and websiteUrl.");
    const websiteUrl = parsed.data.websiteUrl ? new URL(parsed.data.websiteUrl).toString() : null;
    const saved = await updateOrgSettings(org.id, { ...parsed.data, websiteUrl });
    return Response.json({ ...saved, accentColor: parsed.data.accentColor });
  } catch (error) {
    return errorResponse(error);
  }
}
