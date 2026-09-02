import { BASE_DOMAIN } from "@/lib/base-domain";

/** Public dashboard URL; never derive its origin from proxy request headers. */
export function dashboardUrl(path: string) {
  const url = new URL(path, `https://dash.${BASE_DOMAIN}`);
  if (process.env.NODE_ENV === "development" && process.env.PORTLESS_URL) {
    url.port = new URL(process.env.PORTLESS_URL).port;
  }
  return url;
}
