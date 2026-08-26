import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InviteUser } from "@/components/users/invite-user";
import { CopyButton } from "@/components/users/copy-button";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");
  const member = await db.member.findFirst({
    where: { userId: session.user.id, role: { in: ["owner", "admin"] } },
    select: { organizationId: true },
  });
  if (!member) redirect("/auth/no-org");

  const [members, invitations] = await Promise.all([
    db.member.findMany({
      where: { organizationId: member.organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        role: true,
        user: { select: { name: true, email: true } },
      },
    }),
    db.invitation.findMany({
      where: { organizationId: member.organizationId, status: "pending" },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, expiresAt: true },
    }),
  ]);

  const users = members.filter((m) => m.role === "member");
  const trainers = members.filter((m) => m.role !== "member");

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-center justify-between border-b pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Invite users and manage who can practice with your agents.
            </p>
          </div>
        </header>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Invite a user</CardTitle>
            <CardDescription>
              Share the generated link — the user signs up with that email and joins automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InviteUser organizationId={member.organizationId} />
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Pending invites</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {invitations.length === 0 ? (
              <p className="text-muted-foreground text-sm">No pending invitations.</p>
            ) : (
              invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                >
                  <span>{inv.email}</span>
                  <div className="flex items-center gap-2">
                    <code className="text-muted-foreground hidden text-xs sm:inline">
                      /auth/invite?token={inv.id.slice(0, 8)}…
                    </code>
                    <CopyButton value={`https://auth.${BASE_DOMAIN}/invite?token=${inv.id}`} />
                  </div>
                  <Badge variant="secondary">expires {inv.expiresAt.toLocaleDateString()}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {[...trainers, ...users].map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-lg border p-3 text-sm"
              >
                <span className="font-medium">{m.user.name}</span>
                <span className="text-muted-foreground">{m.user.email}</span>
                <Badge variant={m.role === "member" ? "secondary" : "default"}>
                  {m.role === "member" ? "user" : m.role}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
