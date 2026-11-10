import { expect, test } from "@playwright/test";
import { e2eUrl } from "./env";

test.use({ storageState: { cookies: [], origins: [] } });

for (const [code, message] of [
  ["signup_disabled", "There's no TrainerTwin account for that Google email. Sign in with the email your trainer added, or ask them to add you."],
  ["access_denied", "Google sign-in didn't work. Try again, or sign in with a code sent to your email."],
]) {
  test(`Google ${code} lands on a usable sign-in page with a plain error`, async ({ page }) => {
    await page.goto(e2eUrl("auth", `/sign-in?error=${code}`));
    await expect(page.locator("form").getByRole("alert")).toHaveText(message);
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a code", exact: true })).toBeEnabled();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });
}

for (const [code, serverMessage, message] of [
  ["OTP_EXPIRED", "OTP expired", "That code has expired. Send a new code."],
  ["TOO_MANY_ATTEMPTS", "Too many attempts", "Too many tries with that code. Send a new code."],
  ["INVALID_OTP", "User not found", "That code didn't work. Check the code, and that this is the email your trainer added."],
  ["FORBIDDEN", "Your access has been disabled. Contact your trainer.", "Your access has been disabled. Contact your trainer."],
]) {
  test(`email code ${code} is explained without account enumeration`, async ({ page }) => {
    await page.route("**/api/auth/email-otp/send-verification-otp", (route) => route.fulfill({ json: { success: true } }));
    await page.route("**/api/auth/sign-in/email-otp", (route) => route.fulfill({ status: 400, json: { code, message: serverMessage } }));
    await page.goto(e2eUrl("auth", "/sign-in"));
    await page.getByLabel("Email", { exact: true }).fill("learner@example.com");
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByText("If learner@example.com has a TrainerTwin account, we've sent it a code.", { exact: false })).toBeVisible();
    await page.getByLabel("Code", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(message);
    await expect(page.getByRole("button", { name: "Send a new code", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(e2eUrl("auth", "/sign-in"));
  });
}
