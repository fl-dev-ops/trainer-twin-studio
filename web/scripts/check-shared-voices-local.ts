import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { assertRestoreEnvironment } from "./restore-olga-local-skills";

const ORG = "bc657406-6209-4bb8-af6f-c0d8141a17a4";
const path = resolve(import.meta.dir, "../../backups/olga-local/private-voice-phase-baseline.json");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const baselineSchema = z.object({
  database: z.literal("trainertwin_olga_local"),
  rows: z.record(z.string(), z.array(z.object({ id: z.string(), fingerprint: z.string() }))),
  objects: z.record(z.string(), z.string()),
});

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--baseline", "--check"].includes(mode)) throw new Error("Use --baseline or --check");
  assertRestoreEnvironment(process.env);
  process.umask(0o077);
  const client = new Client({
    host: "/tmp", database: "trainertwin_olga_local", options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS db, current_setting('transaction_read_only') AS ro, inet_server_addr() AS address");
    if (identity.rows[0].db !== "trainertwin_olga_local" || identity.rows[0].ro !== "on" || identity.rows[0].address !== null) {
      throw new Error("Local read-only audit identity failed");
    }
    const rows: Record<string, { id: string; fingerprint: string }[]> = {};
    for (const table of ["Voice", "Persona", "Avatar", "Agent", "SpecVersion"]) {
      const result = await client.query<{ id: string; content: string }>(
        `SELECT id, to_jsonb(t)::text AS content FROM "${table}" t WHERE "orgId"=$1 ORDER BY id`, [ORG],
      );
      rows[table] = result.rows.map(({ id, content }) => ({ id, fingerprint: sha(content) }));
    }
    const voices = await client.query<{ s3AudioKey: string; s3TranscriptKey: string | null }>(
      'SELECT "s3AudioKey","s3TranscriptKey" FROM "Voice" WHERE "orgId"=$1', [ORG],
    );
    const s3 = new S3Client({
      endpoint: "http://127.0.0.1:9100", region: "us-east-1", forcePathStyle: true,
      credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
    });
    const objects: Record<string, string> = {};
    for (const voice of voices.rows) {
      for (const key of [voice.s3AudioKey, voice.s3TranscriptKey].filter((key): key is string => Boolean(key))) {
        if (!key.startsWith(`prod/trainertwin/kb/${ORG}/`) || key.includes("..")) throw new Error("Unexpected local voice storage reference");
        const object = await s3.send(new GetObjectCommand({ Bucket: "olga-local", Key: key }));
        if (!object.Body) throw new Error("Missing local voice audio/transcript");
        objects[key] = sha(await object.Body.transformToByteArray());
      }
    }
    const current = { database: "trainertwin_olga_local", rows, objects };
    if (mode === "--baseline") {
      await writeFile(path, JSON.stringify(current), { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
    } else {
      const previous = baselineSchema.parse(JSON.parse(await readFile(path, "utf8")));
      for (const [table, records] of Object.entries(previous.rows)) {
        for (const record of records) {
          if (!rows[table]?.some((row) => row.id === record.id && row.fingerprint === record.fingerprint)) {
            throw new Error(`Original ${table} record changed or disappeared: ${record.id}`);
          }
        }
      }
      for (const [key, fingerprint] of Object.entries(previous.objects)) {
        if (objects[key] !== fingerprint) throw new Error("Original voice object changed or disappeared");
      }
    }
    console.log(JSON.stringify({ mode, rows: Object.fromEntries(Object.entries(rows).map(([table, records]) => [table, records.length])), voiceObjects: Object.keys(objects).length }));
  } finally {
    await client.end();
  }
}

if (import.meta.main) await main();
