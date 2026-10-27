import { type NextRequest, NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { driveConfig, DriveError, driveCookieOptions, DRIVE_STATE_COOKIE, DRIVE_TOKEN_COOKIE, finishDriveOAuth } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Fixed configured origin: never redirect to a callback-supplied URL or reflect its authorization code.
  const target = new URL("/twin/knowledge", driveConfig().studioOrigin);
  const response = NextResponse.redirect(target);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(DRIVE_STATE_COOKIE, "", { ...driveCookieOptions(), maxAge: 0 });
  const actor = await getTrainerOrg();
  try {
    if (!actor) throw new DriveError("Sign in to the studio and connect Google Drive again.", 401);
    const result = await finishDriveOAuth(request.cookies.get(DRIVE_STATE_COOKIE)?.value, actor, request.nextUrl.searchParams);
    response.cookies.set(DRIVE_TOKEN_COOKIE, result.cookie, { ...driveCookieOptions(), maxAge: result.lifetime });
    target.searchParams.set("drive", "connected");
  } catch (error) {
    target.searchParams.set("error", error instanceof DriveError ? error.message : "Google Drive connection failed. Try again.");
  }
  response.headers.set("Location", target.toString());
  return response;
}
