import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { driveConfig, DriveError, DRIVE_PATH } from "@/lib/google-drive";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const paramsSchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(8192).optional(),
  error: z.string().min(1).max(200).optional(),
}).refine((params) => Boolean(params.code) !== Boolean(params.error));

/** No cookies or tokens on localhost: forward to the HTTPS studio, which still verifies session + state + PKCE. */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  try {
    const config = driveConfig();
    if (!config.localBridge || request.nextUrl.origin !== new URL(config.redirectUri).origin) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    }
    const parsed = paramsSchema.safeParse(Object.fromEntries(
      ["state", "code", "error"].filter((key) => request.nextUrl.searchParams.has(key))
        .map((key) => [key, request.nextUrl.searchParams.get(key)]),
    ));
    if (!parsed.success) return NextResponse.json({ error: "Invalid Google callback. Connect again from the studio." }, { status: 400, headers });
    const target = new URL(`${DRIVE_PATH}/oauth/callback`, config.studioOrigin);
    for (const [key, value] of Object.entries(parsed.data)) if (value) target.searchParams.set(key, value);
    return NextResponse.redirect(target, { status: 303, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof DriveError ? error.message : "Local callback is unavailable." }, { status: error instanceof DriveError ? error.status : 500, headers });
  }
}
