"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { organizationAccess, organizationRoles } from "@/lib/auth-roles";

export const authClient = createAuthClient({
  plugins: [organizationClient({ ac: organizationAccess, roles: organizationRoles })],
});
