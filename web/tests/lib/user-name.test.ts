import { describe, expect, test } from "bun:test";
import { emailPlaceholderName, googleProfile, isPlaceholderName } from "@/lib/user-name";

const token = (claims: Record<string, unknown>) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

describe("user names made from an email", () => {
  test("the placeholder is the email's generated lowercase local part", () => {
    expect(emailPlaceholderName("priya.n@acme.com")).toBe("priya.n");
    expect(isPlaceholderName("priya.n", "priya.n@acme.com")).toBe(true);
    expect(isPlaceholderName("priya.n", "Priya.N@acme.com")).toBe(true);
    expect(isPlaceholderName("Priya.N", "priya.n@acme.com")).toBe(false);
    expect(isPlaceholderName("", "priya.n@acme.com")).toBe(true);
    expect(isPlaceholderName(null, "priya.n@acme.com")).toBe(true);
    expect(isPlaceholderName("priya.n@acme.com", "priya.n@acme.com")).toBe(true);
  });
  test("a name someone set is not a placeholder", () => {
    expect(isPlaceholderName("Priya Nair", "priya.n@acme.com")).toBe(false);
  });
  test("Google's name and https photo are read from the ID token; anything else is ignored", () => {
    expect(googleProfile(token({ name: " Priya Nair ", picture: "https://lh3.googleusercontent.com/a/x" })))
      .toEqual({ name: "Priya Nair", picture: "https://lh3.googleusercontent.com/a/x" });
    expect(googleProfile(token({ name: "", picture: "http://insecure" }))).toEqual({});
    expect(googleProfile("not-a-token")).toEqual({});
    expect(googleProfile(null)).toEqual({});
  });
});
