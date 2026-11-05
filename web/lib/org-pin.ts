/**
 * The org a studio tab was loaded for, sent on its same-origin requests (components/org-pin.tsx). The server works in that
 * org when the person is an enabled studio member of it (lib/org.ts), so switching org in one tab never redirects
 * another tab's saves into the new org.
 */
export const ORG_PIN_HEADER = "x-trainertwin-org";
