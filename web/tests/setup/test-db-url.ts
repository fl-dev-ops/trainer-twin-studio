/**
 * The database tests use: the one in .env with "_test" added to its name, on the same local server. Never the dev
 * database itself (it may hold a copy of production), never a remote one (null: database tests then skip).
 */
export function testDatabaseUrl(devUrl = process.env.DATABASE_URL ?? "") {
  if (!URL.canParse(devUrl)) return null;
  const url = new URL(devUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  if (!url.pathname.endsWith("_test")) url.pathname = `${url.pathname}_test`;
  return url.toString();
}
