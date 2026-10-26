// Sends a validated publication to the TrainerTwin web app, which stores it:
// S3 keeps the files, Postgres the runnable scenario, Chroma the items (web/lib/scenario-ingest.ts).
// One call for the run (plan.json, report.md, specs), then one per approved scenario.

type File = { path: string; text: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type StudioTarget = {
  url: string;
  secret: string;
  orgId: string;
  /** Persona the scenarios are played by; matched case-insensitively in the org (e.g. "vasanth"). */
  persona: string;
  runId: string;
};

export type StudioResult = {
  run: { ok: boolean; error?: string };
  scenarios: { id: string; ok: boolean; slug?: string; version?: number; created?: boolean; items?: number; error?: string }[];
};

/** An eve session id, made safe for the web's runId (letters, digits, dot, dash, underscore). */
export function runIdFor(sessionId: string) {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100) || "run";
}

export async function publishToStudio(target: StudioTarget, files: File[], fetcher: Fetch = fetch, signal?: AbortSignal): Promise<StudioResult> {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const post = async (path: string, body: unknown) => {
    const response = await fetcher(new URL(path, target.url).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.secret}`,
        "content-type": "application/json",
        "x-trainertwin-org-id": target.orgId,
      },
      body: JSON.stringify(body),
      signal,
    });
    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(String(result?.error ?? `HTTP ${response.status}`));
    return result ?? {};
  };

  const plan = JSON.parse(byPath.get("plan.json") ?? '{"scenarios":[]}') as { scenarios?: { id: string }[] };
  const specs = Object.fromEntries(
    files.filter((f) => /^specs\/[^/]+\.md$/.test(f.path)).map((f) => [f.path.slice("specs/".length, -".md".length), f.text]),
  );

  const result: StudioResult = { run: { ok: true }, scenarios: [] };
  try {
    await post("/api/internal/scenario-runs", { runId: target.runId, plan, report: byPath.get("report.md") ?? "", specs });
  } catch (e) {
    result.run = { ok: false, error: (e as Error).message };
  }

  // Sequential: each one embeds its items, and the web writes one scenario at a time anyway.
  for (const { id } of plan.scenarios ?? []) {
    const file = (name: string) => byPath.get(`${id}/${name}`);
    const skill = file("SKILL.md");
    const scenario = file("scenario.json");
    const items = file("items.json");
    if (skill == null || scenario == null || items == null) {
      result.scenarios.push({ id, ok: false, error: "SKILL.md, scenario.json or items.json is missing from the publication" });
      continue;
    }
    try {
      const body = await post("/api/internal/scenarios", {
        personaSlug: target.persona,
        skill,
        scenario: JSON.parse(scenario),
        items: JSON.parse(items),
        ...(file("patterns.md") != null ? { patterns: file("patterns.md") } : {}),
        runId: target.runId,
      });
      const stored = (body.scenario ?? {}) as Record<string, unknown>;
      result.scenarios.push({
        id,
        ok: true,
        slug: stored.slug as string,
        version: stored.version as number,
        created: stored.created as boolean,
        items: stored.items as number,
      });
    } catch (e) {
      result.scenarios.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return result;
}
