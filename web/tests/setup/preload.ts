// bunfig.toml [test] preload: runs before any test file (in every --parallel worker), so lib/db connects to the test
// database. .env.test (loaded by bun test) blanks the outside services' keys.
import { testDatabaseUrl } from "./test-db-url";

const url = testDatabaseUrl();
if (url) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED = url;
else delete process.env.DATABASE_URL;
