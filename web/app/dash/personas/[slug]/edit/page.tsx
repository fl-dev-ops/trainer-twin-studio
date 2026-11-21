"use client";

import { useParams } from "next/navigation";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { api, useApi } from "@/lib/api";

export default function EditPersonaPage() {
  const { slug } = useParams<{ slug: string }>();
  const { item, voices } = useApi(["page.personaEdit", slug], () => api.page.personaEdit.query({ slug }));
  return (
    <PersonaEditor
      key={`${slug}-${item.version}-${item.voice?.id ?? "none"}`}
      slug={slug}
      isOwn={item.isOwn}
      initial={item.persona}
      voice={item.voice}
      photoUrl={item.photoUrl}
      voices={voices}
      usedBy={item.usedBy}
    />
  );
}
