/**
 * Runs the ingestion worker against a local database instead of the SQS Lambda.
 * Work items queued by a local Studio are invisible to the deployed Lambda (it
 * reads the production database), so this loop processes them here.
 *
 *   bun --env-file=../web/.env scripts/run-local.ts          # loop every 15 s
 *   bun --env-file=../web/.env scripts/run-local.ts --once   # one pass
 */
import { Pool } from "pg";
import { handler } from "../src/handler";

const once = process.argv.includes("--once");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

async function pass(): Promise<number> {
  const { rows } = await pool.query<{ id: string; jobId: string }>(
    `select w.id, w."jobId" from "IngestionWorkItem" w
      join "IngestionJob" j on j.id = w."jobId"
      where w.status in ('queued', 'pending')
        and (w.status = 'queued' or w."enqueuedAt" is not null)
        and (w."leaseExpiresAt" is null or w."leaseExpiresAt" < now())
        and j.status in ('queued', 'running')
      order by w."createdAt" limit 20`,
  );
  for (const row of rows) {
    const result = await handler({
      Records: [{ messageId: `local-${row.id}`, body: JSON.stringify({ jobId: row.jobId, workItemId: row.id }) }],
    });
    console.log(`[ingest-local] ${row.id}`, JSON.stringify(result));
  }
  return rows.length;
}

do {
  try {
    await pass();
  } catch (error) {
    console.error("[ingest-local] pass failed", error);
  }
  if (!once) await new Promise((resolve) => setTimeout(resolve, 15_000));
} while (!once);
await pool.end();
process.exit(0);
