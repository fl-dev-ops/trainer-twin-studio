import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { resend, sendOtpEmail } from "@/lib/email";

const originalNodeEnv = process.env.NODE_ENV;
let info: ReturnType<typeof spyOn<typeof console, "info">>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  expect(resend).toBeNull(); // .env.test disables real delivery.
  info = spyOn(console, "info").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else Object.assign(process.env, { NODE_ENV: originalNodeEnv });
});

test("without Resend, development prints a real OTP and lets the sign-in form continue", async () => {
  Object.assign(process.env, { NODE_ENV: "development" });
  expect(await sendOtpEmail({ to: "known@example.com", otp: "123456" })).toEqual({ success: true });
  expect(info).toHaveBeenCalledWith("[Dev sign-in] Code for known@example.com: 123456 (expires in 10 minutes)");
});

test.each(["production", "test"])("without Resend, %s fails delivery rather than enabling terminal sign-in", async (nodeEnv) => {
  Object.assign(process.env, { NODE_ENV: nodeEnv });
  expect(await sendOtpEmail({ to: "known@example.com", otp: "123456" })).toMatchObject({ success: false });
  expect(info).not.toHaveBeenCalled();
});
