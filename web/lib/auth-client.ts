"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { getClientBasePath } from "@/lib/tenant-link";

// Standalone tenants hit the auth API at /api/auth; when mounted inside a
// host subpath (e.g. careerwithvasanth.com/interview/...) the auth API is
// reached under the server-injected prefix (e.g. /interview/api/auth).
function getDynamicAuthPath() {
  const base = getClientBasePath();
  return `${base}/api/auth`;
}

export const authClient = createAuthClient({
  basePath: getDynamicAuthPath(),
  plugins: [organizationClient()],
});
