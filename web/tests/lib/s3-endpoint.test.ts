import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const modulePath = fileURLToPath(new URL("../../lib/s3.ts", import.meta.url));

function presign(environment: Record<string, string> = {}) {
  return execFileSync(process.execPath, [
    "--no-env-file",
    "--eval",
    `
      const { presignedGetUrl, presignedPutUrl } = await import(${JSON.stringify(modulePath)});
      const urls = await Promise.all([
        presignedGetUrl("folder/example.txt"),
        presignedPutUrl("folder/example.txt", "text/plain"),
      ]);
      console.log(JSON.stringify(urls.map(value => {
        const url = new URL(value);
        return { origin: url.origin, pathname: url.pathname };
      })));
    `,
  ], {
    env: {
      NODE_ENV: "test",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "local-test",
      AWS_SECRET_ACCESS_KEY: "local-test-secret",
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      AWS_EC2_METADATA_DISABLED: "true",
      S3_BUCKET: "local-test-bucket",
      ...environment,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

test("S3 default endpoints remain unchanged without an endpoint override", () => {
  assert.deepEqual(JSON.parse(presign()), [
    { origin: "https://local-test-bucket.s3.us-east-1.amazonaws.com", pathname: "/folder/example.txt" },
    { origin: "https://local-test-bucket.s3.us-east-1.amazonaws.com", pathname: "/folder/example.txt" },
  ]);
});

test("S3 native endpoint environment uses path style automatically for local IPs", () => {
  assert.deepEqual(JSON.parse(presign({ AWS_ENDPOINT_URL_S3: "http://127.0.0.1:4569" })), [
    { origin: "http://127.0.0.1:4569", pathname: "/local-test-bucket/folder/example.txt" },
    { origin: "http://127.0.0.1:4569", pathname: "/local-test-bucket/folder/example.txt" },
  ]);
});

test("S3 service-specific endpoint takes precedence over the global AWS endpoint", () => {
  assert.deepEqual(JSON.parse(presign({
    AWS_ENDPOINT_URL: "http://127.0.0.1:4570",
    AWS_ENDPOINT_URL_S3: "http://127.0.0.1:4569",
  })), [
    { origin: "http://127.0.0.1:4569", pathname: "/local-test-bucket/folder/example.txt" },
    { origin: "http://127.0.0.1:4569", pathname: "/local-test-bucket/folder/example.txt" },
  ]);
});

test("S3 malformed configured endpoints reject instead of using AWS", () => {
  assert.throws(() => presign({ AWS_ENDPOINT_URL_S3: "not-a-url" }), /Invalid URL/);
});
