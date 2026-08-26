/** Subdomain slugs that can never belong to an organization. */
const RESERVED = new Set([
  "www", "auth", "dash", "api", "app", "admin", "mail", "ftp",
  "blog", "help", "support", "docs", "status", "cdn", "static",
  "assets", "test", "demo", "staging", "dev", "trainertwin",
]);

export function validateOrgSlug(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(slug)) {
    return "Use 3-30 lowercase letters, numbers or hyphens (no leading/trailing hyphen)";
  }
  if (RESERVED.has(slug)) return `"${slug}" is reserved`;
  return null;
}
