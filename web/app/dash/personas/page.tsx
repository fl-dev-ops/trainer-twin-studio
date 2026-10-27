import { PersonaLibrary } from "@/components/persona/persona-library";
import { requireStudioMember } from "@/lib/org";
import { listRolePlayPersonas } from "@/lib/personas";

export const dynamic = "force-dynamic";

/** Persona Library: the role-play personas (isOwn = false). Studio only. */
export default async function PersonasPage() {
  const org = await requireStudioMember();
  return <PersonaLibrary personas={await listRolePlayPersonas(org.id)} />;
}
