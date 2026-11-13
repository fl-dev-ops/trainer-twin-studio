export const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? "trainertwin.localhost";

export function portalSlug(hostHeader: string) {
  return hostHeader.split(":")[0].split(".")[0];
}

export function safeFamilyRedirect(value?: string) {
  if (!value) return null;
  try {
    const target = new URL(value);
    return target.protocol === "https:"
      && (target.hostname === BASE_DOMAIN || target.hostname.endsWith(`.${BASE_DOMAIN}`))
      ? target.toString()
      : null;
  } catch {
    return null;
  }
}

/** `https://<name>.<BASE_DOMAIN>`, keeping the request's port (local proxies such as portless :NNNN). */
export function familyOrigin(hostHeader: string, name: string) {
  const port = hostHeader.includes(":") ? `:${hostHeader.split(":")[1]}` : "";
  return `https://${name}.${BASE_DOMAIN}${port}`;
}

export function signInUrl(hostHeader: string, returnPath?: string) {
  const url = new URL(`${familyOrigin(hostHeader, "auth")}/sign-in`);
  if (returnPath?.startsWith("/")) url.searchParams.set("redirect", `https://${hostHeader}${returnPath}`);
  return url.toString();
}
