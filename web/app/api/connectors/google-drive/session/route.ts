import { type NextRequest, NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { assertDriveOrigin, driveAccess, driveConfig, DriveError, driveCookieOptions, DRIVE_TOKEN_COOKIE } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

/** Token goes only to the signed-in studio user, for Google's picker; secrets and refresh tokens never leave the server. */
export async function GET(request: NextRequest) {
  const actor = await getTrainerOrg();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const config = driveConfig();
    const access = driveAccess(request.cookies.get(DRIVE_TOKEN_COOKIE)?.value, actor);
    return NextResponse.json({ accessToken: access.accessToken, apiKey: config.pickerKey, appId: config.projectNumber }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof DriveError ? error.message : "Could not load Google Drive." }, { status: error instanceof DriveError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: NextRequest) {
  const actor = await getTrainerOrg();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    assertDriveOrigin(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(DRIVE_TOKEN_COOKIE, "", { ...driveCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof DriveError ? error.message : "Could not forget Google Drive access." }, { status: error instanceof DriveError ? error.status : 500 });
  }
}
