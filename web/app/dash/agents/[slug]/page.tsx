"use client";

import { useParams } from "next/navigation";
import { RolePlayPreview } from "@/components/role-play-preview";
import { api, useApi } from "@/lib/api";

export default function RolePlayPreviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const { rolePlay, availableUsers, assignments } = useApi(["page.rolePlayPreview", slug], () =>
    api.page.rolePlayPreview.query({ slug }),
  );
  return <RolePlayPreview rolePlay={rolePlay} availableUsers={availableUsers} assignments={assignments} />;
}
