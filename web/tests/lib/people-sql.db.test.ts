import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { localMinutesDb } from "./minutes-test-db";

// The existing SQL regression fixtures use BEGIN/ROLLBACK; run them against only the same disposable local test DB.
describe.skipIf(!localMinutesDb)("people SQL regression fixtures", () => {
  test.each(["assigned-learner-session.sql", "twin-access.sql"])("%s preserves session isolation and assignment constraints", async (file) => {
    const connection = new Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    try {
      await connection.query(readFileSync(new URL(`../sql/${file}`, import.meta.url), "utf8"));
      expect((await connection.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await connection.query("ROLLBACK");
      await connection.end();
    }
  });
});
