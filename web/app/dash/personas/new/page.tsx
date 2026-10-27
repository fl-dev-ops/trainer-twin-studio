import { PersonaEditor } from "@/components/persona/persona-editor";
import { emptyPersona } from "@/lib/persona";
import { requireStudioMember } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function NewPersonaPage() {
  await requireStudioMember();
  return <PersonaEditor initial={emptyPersona()} />;
}
