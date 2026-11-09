/**
 * The test database (<dev database>_test on the same local server): created when missing, then every migration
 * applied. bun run test:setup. Never touches the dev database or a remote one, and wipes nothing (tests clean up
 * after themselves).
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { testDatabaseUrl } from "../tests/setup/test-db-url";

const url = testDatabaseUrl();
if (!url) throw new Error("DATABASE_URL in .env must be a local database (localhost) to derive the test one");
const name = new URL(url).pathname.slice(1);
const server = new URL(url);
server.pathname = "/postgres";
server.search = "";
const client = new Client({ connectionString: server.toString() });
await client.connect();
const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
if (!exists.rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
await client.end();
const run = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url } });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(`test database ready: ${name}`);
