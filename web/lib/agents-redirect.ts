/**
 * Where an old /agents URL now lives: /agents → /roleplay, /agents/<slug>[/edit|/calibrate|/calibrations/<id>] → the
 * same under /roleplay/<slug>; fidelity and unknown sub-pages → the library or the role play.
 */
export function roleplayPathFor(slug?: string, page?: string, id?: string) {
  if (!slug || slug === "fidelity") return "/roleplay";
  if (slug === "new") return "/roleplay/new";
  const base = `/roleplay/${encodeURIComponent(slug)}`;
  if (page === "edit" || page === "calibrate") return `${base}/${page}`;
  if (page === "calibrations" && id) return `${base}/calibrations/${encodeURIComponent(id)}`;
  return base;
}
