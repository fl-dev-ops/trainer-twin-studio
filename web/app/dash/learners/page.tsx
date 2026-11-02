"use client";

import { LearnersTable } from "@/components/learners/learners-table";
import { api, useApi } from "@/lib/api";

export default function UsersPage() {
  const learners = useApi(["page.learners"], () => api.page.learners.query());
  return <LearnersTable learners={learners} />;
}
