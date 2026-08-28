import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
      select: { id: true, email: true, role: true, expiresAt: true },
    }),
  ]);

  const orderedMembers = [
    ...members.filter((item) => item.role !== "member"),
    ...members.filter((item) => item.role === "member"),
  ];

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow">
        <PageHeader
          className="border-b pb-6"
          title="Users"
          description="Invite users and manage who can access your scenarios."
        />

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
            <CardTitle>Members and invitations</CardTitle>
            <CardDescription>Everyone with access or a pending invitation.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="w-36"></TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orderedMembers.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <span className="block font-medium">{item.user.name}</span>
                      <span className="block text-sm text-muted-foreground">{item.user.email}</span>
                    </TableCell>
                    <TableCell />
                    <TableCell className="capitalize">
                      {item.role === "member" ? "user" : item.role}
                    </TableCell>
                  </TableRow>
                ))}
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>
                      <span className="block font-medium">{invitation.email}</span>
                      <span className="block text-sm text-muted-foreground">
                        Pending invitation · expires {invitation.expiresAt.toLocaleDateString()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <CopyButton
                        value={`https://auth.${BASE_DOMAIN}/invite?token=${invitation.id}`}
                        label="Copy invite"
                      />
                    </TableCell>
                    <TableCell className="capitalize">
                      {invitation.role === "member" || !invitation.role ? "user" : invitation.role}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </PageContainer>
    </main>
  );
}
