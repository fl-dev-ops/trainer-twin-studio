import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { assertDriveOrigin, DriveError, driveCookieOptions, DRIVE_STATE_COOKIE, startDriveOAuth } from "@/lib/google-drive";

export async function POST(request: Request) {
  const actor = await getTrainerOrg();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    assertDriveOrigin(request);
    const result = startDriveOAuth(actor);
    const response = NextResponse.json({ url: result.url }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(DRIVE_STATE_COOKIE, result.cookie, { ...driveCookieOptions(), maxAge: 600 });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof DriveError ? error.message : "Could not connect Google Drive." }, { status: error instanceof DriveError ? error.status : 500 });
  }
}
