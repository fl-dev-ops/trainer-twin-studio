import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { resolveHome } from "@/lib/auth-home";

/** Where should the signed-in user land? Used by the auth forms after login. */
export async function GET() {
  const redirect = await resolveHome();
  return NextResponse.json({ redirect: redirect ?? "/auth/sign-in" });
}
