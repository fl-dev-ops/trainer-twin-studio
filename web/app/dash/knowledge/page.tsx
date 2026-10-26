import { redirect } from "next/navigation";

/** The twin's brain moved to /twin/knowledge; older links (role-play editors, bookmarks) land there. */
export default function KnowledgeRedirect() {
  redirect("/twin/knowledge");
}
