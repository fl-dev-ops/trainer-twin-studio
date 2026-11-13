import { expect, test } from "@playwright/test";
import { e2eUrl } from "./env";

test.use({ storageState: { cookies: [], origins: [] } });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`email-first layout and OTP entry at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let sends = 0;
    await page.route("**/api/auth/email-otp/send-verification-otp", (route) => {
      sends++;
      return route.fulfill({ json: { success: true } });
    });
    await page.goto(e2eUrl("auth", "/sign-in"));
    const email = page.getByLabel("Email", { exact: true });
    const send = page.getByRole("button", { name: "Email me a code", exact: true });
    await expect(email).toBeVisible();
    await expect(send).toBeVisible();
    const emailBox = (await email.boundingBox())!;
    expect((await send.boundingBox())!.y).toBeGreaterThan(emailBox.y + emailBox.height);
    const google = page.getByRole("button", { name: "Continue with Google", exact: true });
    if (await google.count()) {
      await expect(google).toBeVisible();
      const googleBox = (await google.boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(googleBox.y).toBeGreaterThan(sendBox.y + sendBox.height);
      expect(Math.abs(googleBox.height - sendBox.height)).toBeLessThan(2);
      expect(await google.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(await send.evaluate((el) => getComputedStyle(el).borderRadius));
    }
    await page.screenshot({ path: testInfo.outputPath("email.png"), fullPage: true, animations: "disabled" });

    await email.fill("learner.with.a.long.email.address@example.com");
    await send.click();
    await expect(page.locator("#code-help")).toHaveText("Code expires in 10 minutes.");
    const code = page.getByLabel("Code", { exact: true });
    const submit = page.getByRole("button", { name: "Sign in", exact: true });
    const slots = page.locator('[data-slot="input-otp-slot"]');
    await expect(slots).toHaveCount(6);
    await expect(page.locator('[data-slot="input-otp-separator"]')).toHaveCount(0);
    await expect(code).toBeFocused();
    await expect(submit).toBeDisabled();
    const boxes = await slots.evaluateAll((elements) => elements.map((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height, radius: getComputedStyle(el).borderRadius };
    }));
    const inputRadius = await email.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(Math.abs(boxes[0].x - emailBox.x)).toBeLessThan(2);
    expect(Math.abs(boxes[5].x + boxes[5].width - emailBox.x - emailBox.width)).toBeLessThan(2);
    for (const box of boxes) {
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(2);
      expect(Math.abs(box.height - emailBox.height)).toBeLessThan(2);
      expect(box.radius).toBe(inputRadius);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(theme);
        document.documentElement.style.colorScheme = theme;
      }, theme);
      await page.screenshot({ path: testInfo.outputPath(`code-${theme}.png`), fullPage: true, animations: "disabled" });
    }

    // Exercise real input-otp paste and keyboard handling; no real code/email is sent.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await page.evaluate(() => navigator.clipboard.writeText("123456"));
    await code.press("ControlOrMeta+V");
    await expect(code).toHaveValue("123456");
    await expect(slots).toHaveText(["1", "2", "3", "4", "5", "6"]);
    await expect(submit).toBeEnabled();
    await code.press("End");
    await code.press("Backspace");
    await expect(code).toHaveValue("12345");
    await expect(submit).toBeDisabled();
    await code.press("a");
    await expect(code).toHaveValue("12345");
    await page.getByRole("button", { name: "Resend code", exact: true }).click();
    await expect(code).toHaveValue("");
    expect(sends).toBe(2);
    await email.fill("other@example.com");
    await expect(code).toHaveCount(0);
    await expect(send).toBeEnabled();
  });

  test(`unregistered email stays on email entry at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/auth/email-otp/send-verification-otp", (route) => {
      const { email } = route.request().postDataJSON() as { email: string };
      return email === "unknown@example.com"
        ? route.fulfill({ status: 404, json: { code: "USER_NOT_FOUND", message: "This email isn't on TrainerTwin. Ask your trainer to add you." } })
        : route.fulfill({ json: { success: true } });
    });
    await page.goto(e2eUrl("auth", "/sign-in"));
    const email = page.getByLabel("Email", { exact: true });
    const send = page.getByRole("button", { name: "Email me a code", exact: true });
    await email.fill("unknown@example.com");
    await send.click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("This email isn't on TrainerTwin. Ask your trainer to add you.");
    await expect(page.getByLabel("Code", { exact: true })).toHaveCount(0);
    await expect(send).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("unknown-email.png"), fullPage: true, animations: "disabled" });
    await email.fill("known@example.com");
    await send.click();
    await expect(page.getByLabel("Code", { exact: true })).toBeVisible();
    await expect(page.locator("form").getByRole("alert")).toHaveCount(0);
  });
}

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
  test(`email code ${code} is explained clearly`, async ({ page }) => {
    await page.route("**/api/auth/email-otp/send-verification-otp", (route) => route.fulfill({ json: { success: true } }));
    await page.route("**/api/auth/sign-in/email-otp", (route) => route.fulfill({ status: 400, json: { code, message: serverMessage } }));
    await page.goto(e2eUrl("auth", "/sign-in"));
    await page.getByLabel("Email", { exact: true }).fill("learner@example.com");
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByText("Code expires in 10 minutes.", { exact: true })).toBeVisible();
    await page.getByLabel("Code", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(message);
    await expect(page.getByRole("button", { name: "Resend code", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(e2eUrl("auth", "/sign-in"));
  });
}
