"use client";

import { useParams } from "next/navigation";
import { TwinEditPage } from "@/components/twin/twin-edit-page";
import { api, useApi } from "@/lib/api";

export default function TwinConfigureRoute() {
  const { id } = useParams<{ id: string }>();
  const [agent, learners, defaultMinutes] = useApi(["twin.configure", id], () =>
    Promise.all([
      api.twin.agents.get.query({ slug: id }),
      api.twin.assignments.list.query({ slug: id }),
      api.page.twinDefaultMinutes.query(),
    ]),
  );
  return <TwinEditPage twin={agent} learners={learners} defaultMinutes={defaultMinutes} />;
}
