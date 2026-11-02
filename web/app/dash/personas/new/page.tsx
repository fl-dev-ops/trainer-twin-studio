"use client";

import { useState } from "react";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { emptyPersona } from "@/lib/persona";

/** A new persona. Studio only (app/dash/personas/layout.tsx). */
export default function NewPersonaPage() {
  const [initial] = useState(emptyPersona);
  return <PersonaEditor initial={initial} />;
}
