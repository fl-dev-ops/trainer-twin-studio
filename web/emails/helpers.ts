/** Shared text helpers for email templates: escape values for HTML, keep plain text readable. */
export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
