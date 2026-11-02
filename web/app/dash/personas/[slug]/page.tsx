"use client";

import { useParams, useSearchParams } from "next/navigation";
import { PersonaDetail } from "@/components/persona/persona-detail";
import { SpecResourcePage } from "@/components/spec-resource-page";
import { api, useApi } from "@/lib/api";

/** A persona's page. `?view=spec` (and global personas) open the spec page with recordings and recorded style. */
export default function PersonaPage() {
  const { slug } = useParams<{ slug: string }>();
  const query = useSearchParams();
  const version = query.get("version") ?? undefined;
  const spec = query.get("view") === "spec";
  const loaded = useApi(["page.persona", slug, version, spec], () => api.page.persona.query({ slug, version, spec }));
  if (loaded.view === "persona") return <PersonaDetail item={loaded.item} />;
  return <SpecResourcePage loaded={loaded} />;
}
