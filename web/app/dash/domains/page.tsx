import { redirect } from "next/navigation";

/** Domains are generated implementation details, never a Studio surface. */
export default function DomainsPage() {
  redirect("/agents");
}
