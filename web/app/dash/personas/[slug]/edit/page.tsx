"use client";

import { useParams, useSearchParams } from "next/navigation";
import { PersonaEditor, type PersonaTab } from "@/components/persona/persona-editor";
import { api, useApi } from "@/lib/api";

const TABS: PersonaTab[] = ["look", "talk", "media"];

export default function EditPersonaPage() {
  const { slug } = useParams<{ slug: string }>();
  const tab = useSearchParams().get("tab");
  const { item, voices } = useApi(["page.personaEdit", slug], () => api.page.personaEdit.query({ slug }));
  return (
    <PersonaEditor
      key={`${slug}-${item.version}`}
      slug={slug}
      isOwn={item.isOwn}
      initial={item.persona}
      media={{ photoUrl: item.photoUrl, hasVideo: item.hasVideo, voiceName: item.voice?.name ?? null }}
      voices={voices}
      defaultTab={TABS.find((t) => t === tab) ?? "look"}
    />
  );
}
