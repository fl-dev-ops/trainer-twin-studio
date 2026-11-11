import { expect, test } from "bun:test";
import { seller } from "../setup/billing-meteroid-fixture";

async function setup(mode: string) {
  const child = Bun.spawn([process.execPath, "--preload", "./tests/setup/billing-meteroid-script-preload.ts", "scripts/meteroid-billing-setup.ts", "--webhook-url", "https://dash.test/api/meteroid/webhook"], {
    cwd: process.cwd(), env: { ...process.env, METEROID_API_KEY: "test-meteroid-key", METEROID_API_URL: "https://meteroid.test", METEROID_GRPC_URL: "https://meteroid-grpc.test", BILLING_SETUP_SELLER_FIXTURE: mode }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("billing setup never overwrites an invoicing entity already filled in Meteroid", async () => {
  const result = await setup("filled");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`ok: invoicing entity filled in (${seller.name}, GSTIN ${seller.gstin}); edit it in Meteroid`);
  expect(result.stderr).toContain("/GetInvoicingEntity");
  expect(result.stderr).not.toContain("/UpdateInvoicingEntity");
  expect(result.stderr).not.toContain("/plans");
});

test("billing setup fills an invoicing entity whose GSTIN is missing", async () => {
  const result = await setup("missing-gstin");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("/UpdateInvoicingEntity");
  expect(result.stdout).toContain("done: invoicing entity entity-default:");
});

test("billing setup must not overwrite a present GSTIN when the legal name is missing", async () => {
  const result = await setup("missing-name");
  expect(result.stderr).not.toContain("/UpdateInvoicingEntity");
});

test("billing setup must fail closed without updating when invoicing entity lookup is unavailable", async () => {
  const result = await setup("unavailable");
  expect(result.stderr).not.toContain("/UpdateInvoicingEntity");
  expect(result.exitCode).not.toBe(0);
});
