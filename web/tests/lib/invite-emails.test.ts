import { expect, test } from "bun:test";
import { parseInviteEmails } from "@/lib/invite-emails";

test("splits on commas, semicolons, spaces and new lines; lower-cases and de-duplicates", () => {
  expect(parseInviteEmails(" A@x.com, b@y.org;c@z.io\nd@w.co  a@X.com ,, ")).toEqual({
    emails: ["a@x.com", "b@y.org", "c@z.io", "d@w.co"],
    invalid: [],
  });
});

test("keeps invalid entries apart so nothing is sent until they are fixed", () => {
  expect(parseInviteEmails("ok@x.com, nope, bad@, @x.com")).toEqual({ emails: ["ok@x.com"], invalid: ["nope", "bad@", "@x.com"] });
  expect(parseInviteEmails("   ")).toEqual({ emails: [], invalid: [] });
});
