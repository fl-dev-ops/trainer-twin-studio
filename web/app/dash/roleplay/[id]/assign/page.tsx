"use client";

import { useParams } from "next/navigation";
import { RoleplayAssignPage } from "@/components/roleplay/roleplay-assign-page";
import { api, useApi } from "@/lib/api";

/** Assign a role play: members, and the assign dialog over the org's learners. */
export default function RoleplayAssignRoute() {
  const { id } = useParams<{ id: string }>();
  const [detail, learners] = useApi(["roleplay.assign", id], () =>
    Promise.all([api.roleplay.scenarios.get.query({ slug: id }), api.roleplay.users.orgLearners.query()]),
  );
  return <RoleplayAssignPage roleplay={detail} learners={learners} />;
}
