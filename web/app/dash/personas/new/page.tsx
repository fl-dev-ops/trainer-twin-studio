"use client";

import { useState } from "react";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { api, useApi } from "@/lib/api";
import { emptyPersona } from "@/lib/persona";

/** A new persona. Studio only (app/dash/personas/layout.tsx). */
export default function NewPersonaPage() {
  const [initial] = useState(emptyPersona);
  const { voices } = useApi(["page.personaNew"], () => api.page.personaNew.query());
  return <PersonaEditor initial={initial} voices={voices} />;
}
