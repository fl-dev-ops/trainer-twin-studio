import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";
import { BASE_DOMAIN } from "@/lib/base-domain";

// No DOM dependency: run the components' actual handlers, retaining hook state between renders.
let state: unknown[] = [];
let cursor = 0;
const realReact = { ...React };
mock.module("react", () => ({ ...realReact, useState: (initial: unknown) => {
  const index = cursor++;
  if (!(index in state)) state[index] = initial;
  return [state[index], (value: unknown) => { state[index] = value; }];
} }));
const social = mock(async (_args: unknown) => ({ error: null }));
const emailOtp = mock(async (_args: unknown): Promise<{ error: { code?: string; message?: string } | null }> => ({ error: null }));
const send = mock(async (_args: unknown) => ({ error: null }));
const push = mock();
mock.module("@/lib/auth-client", () => ({ authClient: { signIn: { social, emailOtp }, emailOtp: { sendVerificationOtp: send } } }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push }), redirect: mock() }));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
const { SignInForm } = await import("@/components/auth/sign-in-form");
const { GoogleSignInButton } = await import("@/components/auth/google-sign-in-button");
const { default: SignInPage } = await import("@/app/auth/sign-in/page");

type Element = ReactElement<Record<string, any>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
const render = <T,>(component: () => T) => { cursor = 0; return component(); };
const form = () => render(() => SignInForm({ googleEnabled: true }));
const alert = (node: ReactNode) => find(node, (element) => element.props.role === "alert")?.props.children;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => { state = []; cursor = 0; for (const fn of [social, emailOtp, send, push]) fn.mockClear(); });
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const invalid = "That code didn't work. Check the code, and that this is the email your trainer added.";
test.each([
  { error: { code: "OTP_EXPIRED", message: "OTP expired" }, message: "That code has expired. Send a new code." },
  { error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" }, message: "Too many tries with that code. Send a new code." },
  { error: { code: "INVALID_OTP", message: "User not found" }, message: invalid },
  { error: { code: "INVALID_OTP", message: "Wrong code" }, message: invalid },
  { error: { code: "UNKNOWN" }, message: invalid },
  { error: {}, message: invalid },
  { error: { code: "FORBIDDEN", message: "Your access has been disabled. Contact your trainer." }, message: "Your access has been disabled. Contact your trainer." },
])("codeError displays $message without leaking account existence ($error)", async ({ error, message }) => {
  find(form(), (el) => el.props.id === "email")!.props.onChange({ target: { value: " learner@example.com " } });
  await find(form(), (el) => el.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect(send).toHaveBeenCalledWith({ email: "learner@example.com", type: "sign-in" });
  find(form(), (el) => el.props.id === "code")!.props.onChange({ target: { value: "123456" } });
  emailOtp.mockResolvedValueOnce({ error });
  await find(form(), (el) => el.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect(emailOtp).toHaveBeenCalledWith({ email: "learner@example.com", otp: "123456" });
  expect(alert(form())).toBe(message);
  expect(push).not.toHaveBeenCalled();
  expect(find(form(), (el) => el.props.type === "submit")!.props.disabled).toBe(false);
});

test.each(["signup_disabled", "signup disabled", "access_denied", undefined])("signInError maps Google %s and retains a safe redirect", async (error) => {
  const redirect = `https://acme.${BASE_DOMAIN}/s/code`;
  const page = await SignInPage({ searchParams: Promise.resolve({ error, redirect }) });
  const props = find(page, (el) => el.type === SignInForm)!.props;
  expect(props.redirectTo).toBe(redirect);
  expect(props.error).toBe(error === undefined ? undefined : error.startsWith("signup")
    ? "There's no TrainerTwin account for that Google email. Sign in with the email your trainer added, or ask them to add you."
    : "Google sign-in didn't work. Try again, or sign in with a code sent to your email.");
  expect(alert(render(() => SignInForm(props as Parameters<typeof SignInForm>[0])))).toBe(props.error);
});

test.each([
  { port: "", callbackURL: undefined },
  { port: "3999", callbackURL: undefined },
  { port: "3999", callbackURL: `https://acme.${BASE_DOMAIN}:3999/s/code?a=1&b=2` },
])("GoogleSignInButton sends sign-in errorCallbackURL with the full return URL ($port, $callbackURL)", async ({ port, callbackURL }) => {
  const href = `https://acme.${BASE_DOMAIN}${port ? `:${port}` : ""}/t/twin?x=1&y=2`;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href, port } } });
  const button = render(() => GoogleSignInButton({ callbackURL }));
  await find(button, (el) => typeof el.props.onClick === "function")!.props.onClick();
  const back = callbackURL ?? href;
  expect(social).toHaveBeenCalledWith({ provider: "google", callbackURL: back,
    errorCallbackURL: `https://auth.${BASE_DOMAIN}${port ? `:${port}` : ""}/sign-in?redirect=${encodeURIComponent(back)}` });
  expect(new URL(social.mock.calls[0][0].errorCallbackURL).searchParams.get("redirect")).toBe(back);
});
