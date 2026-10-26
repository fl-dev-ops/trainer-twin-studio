import { TwinUsersPage } from "@/components/twin/twin-users-page";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinUsersRoute() {
  const twin = await twinServer();
  return <TwinUsersPage learners={await twin.users.list()} />;
}
