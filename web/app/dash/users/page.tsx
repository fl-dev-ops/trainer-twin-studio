"use client";

import { api, useApi } from "@/lib/api";
import { UsersTable } from "@/components/users/users-table";

/** Repurposed Learners page: everyone in the org with their twin and role-play activity. */
export default function UsersRoute() {
  const users = useApi(["page.users"], () => api.page.users.query());
  return <UsersTable users={users} />;
}
