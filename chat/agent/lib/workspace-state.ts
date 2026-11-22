import { studioFetch } from "./studio";

const labels: Record<string, string> = {
  code: "Code editor", canvas: "Whiteboard", choice: "Multiple choice",
  pdf: "PDF document viewer", image: "Image viewer", presentation: "Presentation",
};

export function formatWorkspaceState(state: { active?: string | null; key?: string | null; updatedAt?: string } | null): string {
  if (!state) return "WORKSPACE STATE: not reported. Use workspace inspection tools; do not assume a surface is open.";
  return `WORKSPACE STATE (latest browser report):\n- Active surface: ${labels[state.active ?? ""] ?? "none"}\n- Active resource key: ${JSON.stringify(state.key ?? null)}\nUse workspace inspection tools to read its contents; this report only identifies the open surface.`;
}

/** Mutable browser state must not share the immutable session-spec memo. */
export async function loadWorkspaceState(orgId: string, sessionId: string): Promise<string> {
  try {
    const result = await studioFetch<{ uiState: Parameters<typeof formatWorkspaceState>[0] }>(orgId, { action: "getWorkspaceState", sessionId });
    return formatWorkspaceState(result.uiState);
  } catch {
    return "WORKSPACE STATE: unavailable. Use workspace inspection tools; do not assume a surface is open.";
  }
}
