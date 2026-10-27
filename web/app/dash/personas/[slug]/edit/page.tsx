import { notFound } from "next/navigation";
import { PersonaEditor, type PersonaTab } from "@/components/persona/persona-editor";
import { requireStudioMember } from "@/lib/org";
import { getPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";

const TABS: PersonaTab[] = ["look", "talk", "media"];

export default async function EditPersonaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ slug }, { tab }] = await Promise.all([params, searchParams]);
  const org = await requireStudioMember();
  const item = await getPersona(org.id, slug);
  if (!item) notFound();
  return (
    <PersonaEditor
      key={`${slug}-${item.version}`}
      slug={slug}
      isOwn={item.isOwn}
      initial={item.persona}
      media={{ photoUrl: item.photoUrl, hasVideo: item.hasVideo, voiceName: item.voice?.name ?? null }}
      defaultTab={TABS.find((t) => t === tab) ?? "look"}
    />
  );
}
