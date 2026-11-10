import { BASE_DOMAIN } from "@/lib/base-domain";

/** A learner signs in on their org's home page (<org>.<base>/). */
export const orgHomeUrl = (orgSlug: string) => `https://${orgSlug}.${BASE_DOMAIN}/`;

/** Admin and team sign in to the studio. */
export const studioUrl = () => `https://dash.${BASE_DOMAIN}/`;

/** Where someone added to an org signs in, by role (learners: their org home; admin, team: the studio). */
export const signInUrl = (role: string, orgSlug: string) => (role === "user" ? orgHomeUrl(orgSlug) : studioUrl());
