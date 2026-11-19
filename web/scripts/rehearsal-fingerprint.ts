/**
 * Migration rehearsal evidence: a fingerprint of every table that exists in a database, over a fixed set of columns.
 *
 *   bun scripts/rehearsal-fingerprint.ts --db <name> --out before.json                 # all columns as they are now
 *   bun scripts/rehearsal-fingerprint.ts --db <name> --columns before.json --out after.json   # same columns again
 *   bun scripts/rehearsal-fingerprint.ts --compare before.json after.json
 *
 * Read-only (runs in a READ ONLY transaction) and local only (Unix-socket localhost). A table's fingerprint is its row
 * count plus an md5 over its rows' chosen columns in primary-key order, so additive migrations (new columns/tables)
 * leave earlier fingerprints unchanged and any rewrite of existing data shows up by table.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SQL } from "bun";

type Fingerprint = { database: string; takenAt: string; tables: Record<string, { columns: string[]; missingColumns?: string[]; rows: number; md5: string }> };

const argv = process.argv.slice(2);
const option = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function fingerprint(database: string, columnsFrom?: Fingerprint): Promise<Fingerprint> {
  if (!/^trainertwin_[a-z0-9_]+$/.test(database)) throw new Error("Use a local trainertwin_* database name");
  const sql = new SQL(`postgres://${process.env.USER}@localhost/${database}?host=/tmp`);
  try {
    return await sql.begin("read only", async (tx) => {
      const tables = columnsFrom
        ? Object.keys(columnsFrom.tables)
        : (await tx`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1`).map((r: { table_name: string }) => r.table_name);
      const out: Fingerprint["tables"] = {};
      for (const table of tables) {
        const exists = (await tx`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`).length > 0;
        if (!exists) { out[table] = { columns: [], rows: -1, md5: "missing" }; continue; }
        const present = (await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`).map((r: { column_name: string }) => r.column_name);
        // With an earlier fingerprint: its columns that still exist (a dropped/renamed column is reported, not hashed).
        const wanted = columnsFrom?.tables[table]?.columns ?? present;
        const columns = wanted.filter((column) => present.includes(column));
        const missingColumns = wanted.filter((column) => !present.includes(column));
        const keys = (await tx`
          SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = ${`public.${ident(table)}`}::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`).map((r: { attname: string }) => r.attname);
        const order = (keys.length ? keys : columns).map(ident).join(", ");
        const row = `json_build_array(${columns.map(ident).join(", ")})::text`;
        const [result] = await tx.unsafe(`SELECT count(*)::int AS rows, coalesce(md5(string_agg(${row}, E'\\n' ORDER BY ${order})), 'empty') AS md5 FROM public.${ident(table)}`);
        out[table] = { columns, ...(missingColumns.length ? { missingColumns } : {}), rows: result.rows, md5: result.md5 };
      }
      return { database, takenAt: new Date().toISOString(), tables: out };
    });
  } finally {
    await sql.close();
  }
}

if (argv[0] === "--compare") {
  const [before, after] = argv.slice(1, 3).map((path) => JSON.parse(readFileSync(path, "utf8")) as Fingerprint);
  const changed = Object.entries(before.tables).filter(([table, value]) => after.tables[table]?.md5 !== value.md5 || after.tables[table]?.rows !== value.rows)
    .map(([table, value]) => ({ table, rowsBefore: value.rows, rowsAfter: after.tables[table]?.rows }));
  const dropped = Object.entries(after.tables).filter(([, value]) => value.missingColumns?.length).map(([table, value]) => ({ table, columns: value.missingColumns }));
  console.log(JSON.stringify({ tables: Object.keys(before.tables).length, unchanged: Object.keys(before.tables).length - changed.length, changed, droppedColumns: dropped }, null, 2));
  if (changed.length) process.exitCode = 1;
} else {
  const database = option("db");
  const out = option("out");
  if (!database || !out) throw new Error("Usage: --db <name> --out <file> [--columns <earlier fingerprint>] | --compare a.json b.json");
  const columns = option("columns") ? JSON.parse(readFileSync(option("columns")!, "utf8")) as Fingerprint : undefined;
  const result = await fingerprint(database, columns);
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`${Object.keys(result.tables).length} tables fingerprinted from ${database}`);
}
