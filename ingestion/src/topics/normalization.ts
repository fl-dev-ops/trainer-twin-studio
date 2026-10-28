/** Same comparison key as rounds-prototype Skills; C, C++, and C# stay distinct. */
export function normalizeTopicToken(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

/** New stored slugs use lowercase words separated by hyphens, never + or #. */
export function normalizeTopicSlug(name: string): string {
  return name.toLowerCase().replace(/\+/g, "-plus-").replace(/#/g, "-sharp-")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolve spelling variants to an existing slug; ambiguous legacy duplicates fail closed. */
export function createTopicResolver(slugs: Iterable<string>): (name: string) => string | undefined {
  const exact = new Set(slugs);
  const byToken = new Map<string, string | null>();
  for (const slug of exact) {
    for (const token of [normalizeTopicToken(slug), normalizeTopicToken(normalizeTopicSlug(slug))]) {
      if (token) byToken.set(token, byToken.has(token) && byToken.get(token) !== slug ? null : slug);
    }
  }
  return (name) => {
    if (exact.has(name)) return name;
    const slug = normalizeTopicSlug(name);
    if (exact.has(slug)) return slug;
    return byToken.get(normalizeTopicToken(name)) ?? byToken.get(normalizeTopicToken(slug)) ?? undefined;
  };
}

export type TopicInfo = { slug: string; description: string };

/** Validate discovery output and collapse formatting variants within the same response. */
export function parseTopicProposals(raw: unknown): TopicInfo[] {
  if (!raw || typeof raw !== "object" || !("topics" in raw) || !Array.isArray(raw.topics)) return [];
  const topics = new Map<string, TopicInfo>();
  for (const item of raw.topics) {
    if (!item || typeof item.slug !== "string") continue;
    const slug = normalizeTopicSlug(item.slug);
    const token = normalizeTopicToken(slug);
    if (!token || topics.has(token)) continue;
    const description = typeof item.description === "string" && item.description.trim()
      ? item.description.trim() : slug.replace(/-/g, " ");
    topics.set(token, { slug, description: description.slice(0, 200) });
  }
  return [...topics.values()];
}
