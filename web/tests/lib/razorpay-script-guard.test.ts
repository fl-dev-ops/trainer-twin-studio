import { afterEach, beforeEach, expect, test } from "bun:test";
import { checkScriptKeys } from "../../scripts/razorpay-script-guard";

let databaseUrl: string | undefined;
let keyId: string | undefined;
beforeEach(() => {
  databaseUrl = process.env.DATABASE_URL;
  keyId = process.env.RAZORPAY_KEY_ID;
});
afterEach(() => {
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  if (keyId === undefined) delete process.env.RAZORPAY_KEY_ID;
  else process.env.RAZORPAY_KEY_ID = keyId;
});

for (const host of ["ep-test.neon.tech", "test.amazonaws.com"]) {
  test(`${host}: production needs explicit approval and live keys`, () => {
    process.env.DATABASE_URL = `postgresql://test:fake@${host}:5432/test`;
    process.env.RAZORPAY_KEY_ID = "rzp_live_fake";
    expect(() => checkScriptKeys([])).toThrow("add --production");
    expect(() => checkScriptKeys(["--production"])).not.toThrow();
    process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
    expect(() => checkScriptKeys(["--production"])).toThrow("production database needs live Razorpay keys");
  });
}

test.each(["localhost", "127.0.0.1"])("%s: local DB allows test keys but refuses live keys even with --production", (host) => {
  process.env.DATABASE_URL = `postgresql://test:fake@${host}:5432/test`;
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
  expect(() => checkScriptKeys([])).not.toThrow();
  process.env.RAZORPAY_KEY_ID = "rzp_live_fake";
  expect(() => checkScriptKeys([])).toThrow("live Razorpay keys with a local database");
  expect(() => checkScriptKeys(["--production"])).toThrow("live Razorpay keys with a local database");
});

test("BUG: a remote DB outside Neon/AWS must also require --production", () => {
  process.env.DATABASE_URL = "postgresql://test:fake@db.example.com:5432/test";
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
  expect(() => checkScriptKeys([])).toThrow("add --production");
});

test("BUG: a remote DB outside Neon/AWS must refuse test keys with --production", () => {
  process.env.DATABASE_URL = "postgresql://test:fake@db.example.com:5432/test";
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
  expect(() => checkScriptKeys(["--production"])).toThrow("production database needs live Razorpay keys");
});
