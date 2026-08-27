import { NextResponse } from "next/server";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { getSessionOrg } from "@/lib/org";

export async function POST(req: Request) {
  try {
    const org = await getSessionOrg();
    if (!org) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      rolePlaySlug,
      rolePlayName,
      rolePlayObjective,
      userIds,
      trainerName = "Vasanth",
    } = body;

    if (!Array.isArray(userIds) || userIds.length === 0 || !rolePlaySlug) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Fetch the targeted users from database
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });

    const practiceUrl = `https://${org.slug}.${BASE_DOMAIN}/session/${encodeURIComponent(rolePlaySlug)}`;

    // Send assignment emails in parallel
    const results = await Promise.allSettled(
      users.map((user) =>
        sendRolePlayAssignmentEmail({
          to: user.email,
          userName: user.name,
          rolePlayName: rolePlayName || rolePlaySlug,
          rolePlayObjective,
          practiceUrl,
          trainerName,
        }),
      ),
    );

    const sentCount = results.filter((r) => r.status === "fulfilled").length;

    return NextResponse.json({ success: true, sentCount });
  } catch (error) {
    console.error("Failed to send assignment emails:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 },
    );
  }
}
