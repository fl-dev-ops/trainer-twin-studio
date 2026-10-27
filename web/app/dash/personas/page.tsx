import { PersonaLibrary } from "@/components/persona/persona-library";
import { requireStudioMember } from "@/lib/org";
import { listPersonas } from "@/lib/personas";

export const dynamic = "force-dynamic";

/** Persona Library: the trainer's own persona and the role-play personas. Studio only. */
export default async function PersonasPage() {
  const org = await requireStudioMember();
  return <PersonaLibrary personas={await listPersonas(org.id)} />;
}
