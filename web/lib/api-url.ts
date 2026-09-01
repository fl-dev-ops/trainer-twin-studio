import { tenantLink, dashLink, getClientBasePath } from "@/lib/tenant-link";

export { tenantLink, dashLink, getClientBasePath };

/**
 * Client-side API URL builder. Uses server-authoritative basePath from
 * the page's <meta name="twin-base-path"> tag; standalone tenants mount at
 * the root and get no prefix.
 */
export function apiUrl(path: string, basePath?: string | null): string {
  const prefix = basePath ?? getClientBasePath();
  return tenantLink(path, prefix);
}
