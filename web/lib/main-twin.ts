/**
 * Whether a session on this agent speaks with all of its persona's twin skills: the trainer's main twin
 * (data.source "twin"), or a bot (its public side, lib/bots). Skill twins and role plays run their one skill.
 */
export function runsAsMainTwin(kind: string | null | undefined, data: unknown) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).source : undefined;
  return (kind === "TWIN" && source === "twin") || kind === "BOT";
}
