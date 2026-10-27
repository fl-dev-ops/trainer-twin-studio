/**
 * Copies S3 objects for scripts/port-prod.sh: reads "<from key>\t<to key>" lines on stdin, copies each object inside the
 * bucket. Prod keys are only read. Refuses to write outside the local base prefix, so a bad pair can never touch prod.
 *   psql ... -c "COPY (SELECT old, new ...) TO STDOUT" | bun scripts/port-prod-s3.ts
 */
import { getObjectBytes, putObject } from "../lib/s3";

const localBase = (process.env.S3_BASE_PREFIX?.trim() || "trainertwin-dev").replace(/^\/+|\/+$/g, "");
const pairs = (await new Response(Bun.stdin.stream()).text())
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t") as [string, string]);

let copied = 0;
const failed: string[] = [];
for (const [from, to] of pairs) {
  if (!to?.startsWith(`${localBase}/`)) throw new Error(`refusing to write outside ${localBase}/: ${to}`);
  try {
    await putObject(to, await getObjectBytes(from), to.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream");
    copied++;
  } catch (error) {
    failed.push(`${from}: ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`s3: ${copied}/${pairs.length} objects copied`);
if (failed.length) {
  console.error(failed.join("\n"));
  process.exit(1);
}
