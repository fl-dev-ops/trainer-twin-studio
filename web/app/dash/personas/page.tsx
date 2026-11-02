"use client";

import { PersonaLibrary } from "@/components/persona/persona-library";
import { api, useApi } from "@/lib/api";

/** Persona Library: the trainer's own persona and the role-play personas. Studio only. */
export default function PersonasPage() {
  const personas = useApi(["page.personas"], () => api.page.personas.query());
  return <PersonaLibrary personas={personas} />;
}
