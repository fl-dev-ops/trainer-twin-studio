export const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? "trainertwin.localhost";

export function portalSlug(hostHeader: string) {
  return hostHeader.split(":")[0].split(".")[0];
}

/**
 * Tenant slug: prefer the host-delegated header (set by the host proxy) and
 * fall back to the subdomain's first label for standalone deployments.
 */
export function tenantSlug(hostHeader: string, forwardedTenant?: string | null) {
  return forwardedTenant || portalSlug(hostHeader);
}

export function signInUrl(hostHeader: string) {
  const isDev = process.env.NODE_ENV !== "production";
  const proto = isDev ? "http" : "https";
  const port = hostHeader.includes(":") ? `:${hostHeader.split(":")[1]}` : "";
  return `${proto}://auth.${BASE_DOMAIN}${port}/sign-in`;
}
