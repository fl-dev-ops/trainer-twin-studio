"use client";

import { RoleplayUsersPage } from "@/components/roleplay/roleplay-users-page";
import { api, useApi } from "@/lib/api";

/** Roleplay users: everyone invited to or practising on the org's role plays. */
export default function RoleplayUsersRoute() {
  const users = useApi(["roleplay.users.list"], () => api.roleplay.users.list.query());
  return <RoleplayUsersPage users={users} />;
}
