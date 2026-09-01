/**
 * Server-authoritative client-side base path provided via <meta name="twin-base-path">.
 * Empty string for standalone tenants; e.g. "/interview" for host-delegated mounts.
 */
export function getClientBasePath(): string {
  if (typeof document === "undefined") return "";
  const meta = document.querySelector('meta[name="twin-base-path"]');
  const content = meta?.getAttribute("content");
  return content && content.startsWith("/") ? content : "";
}

/** Per-organization JSON config (Organization.config column). */
export interface OrganizationConfig {
  basePath?: string | null; // e.g. "/interview" or null
  customDomain?: string | null; // e.g. "interview.careerwithvasanth.com"
  themeAccent?: string | null;
  features?: Record<string, boolean>;
}

/**
 * Tenant-aware link builder. Standalone tenants (basePath null) get plain
 * root paths; host-embedded tenants (basePath "/interview") get the subpath
 * prefix so client-side navigation stays inside the host mount.
 */
export function tenantLink(path: string, basePath?: string | null): string {
  const prefix = (basePath || "").replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${prefix}${cleanPath}`;
}

/**
 * Studio Dash-aware link builder. When embedded inside a host subpath (basePath "/interview"),
 * dash routes live under `/interview/dash/*`. On the standalone dash subdomain,
 * routes mount directly at the root (e.g. `/agents`, `/sessions`).
 */
export function dashLink(path: string, basePath?: string | null): string {
  const base = (basePath || "").replace(/\/+$/, "");
  if (base) {
    const clean = path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
    return `${base}/dash${clean}`;
  }
  return path;
}
