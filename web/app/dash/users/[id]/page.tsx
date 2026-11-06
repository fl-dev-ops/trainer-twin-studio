"use client";

import { useParams } from "next/navigation";
import { UserDetailPage } from "@/components/users/user-detail-page";
import { api, useApi } from "@/lib/api";

export default function UserDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const data = useApi(["twin.users.get", id], () => api.twin.users.get.query({ id }));
  return <UserDetailPage user={data.user} sessions={data.sessions} />;
}
