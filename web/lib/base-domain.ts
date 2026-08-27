/** The platform's base domain. Client-safe (no server imports here). */
export const BASE_DOMAIN = "trainertwin.localhost";

export function portalSlug(hostHeader: string) {
  return hostHeader.split(":")[0].split(".")[0];
}

export function signInUrl(hostHeader: string) {
  const port = hostHeader.includes(":") ? `:${hostHeader.split(":")[1]}` : "";
  return `https://auth.${BASE_DOMAIN}${port}/sign-in`;
}
