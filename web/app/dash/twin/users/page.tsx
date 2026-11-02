"use client";

import { TwinUsersPage } from "@/components/twin/twin-users-page";
import { api, useApi } from "@/lib/api";

export default function TwinUsersRoute() {
  const learners = useApi(["twin.users.list"], () => api.twin.users.list.query());
  return <TwinUsersPage learners={learners} />;
}
