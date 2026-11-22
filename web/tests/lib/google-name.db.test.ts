import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, localMinutesDb } from "./minutes-test-db";
import { fillNameFromGoogle } from "@/lib/auth";

const idToken = (claims: Record<string, unknown>) =>
  ["h", Buffer.from(JSON.stringify(claims)).toString("base64url"), "s"].join(".");

describe.skipIf(!localMinutesDb)("Google sign-in fills a placeholder name (local database)", () => {
  const users: string[] = [];
  afterEach(async () => {
    await db.account.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = 0;
  });
  async function person(name: string, image: string | null = null) {
    const id = randomUUID();
    users.push(id);
    const email = `priya.${id.slice(0, 8)}@example.com`;
    await db.user.create({ data: { id, email, name: name === "<prefix>" ? email.split("@")[0] : name, emailVerified: false, image } });
    return { id, email };
  }
  async function link(userId: string, claims: Record<string, unknown>, providerId = "google") {
    const account = await db.account.create({
      data: { id: randomUUID(), userId, providerId, accountId: randomUUID(), idToken: idToken(claims), createdAt: new Date(), updatedAt: new Date() },
    });
    return account;
  }

  test("the email-prefix name and missing photo are replaced on link", async () => {
    const user = await person("<prefix>");
    const account = await link(user.id, { name: "Priya Nair", picture: "https://lh3.googleusercontent.com/a/p" });
    await fillNameFromGoogle(account);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, image: true } }))
      .toEqual({ name: "Priya Nair", image: "https://lh3.googleusercontent.com/a/p" });
  });
  test("a later sign-in (account update with only an id) still fills it", async () => {
    const user = await person("<prefix>");
    const account = await link(user.id, { name: "Priya Nair" });
    await fillNameFromGoogle({ id: account.id });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe("Priya Nair");
  });
  test("a name set on purpose, an existing photo and other providers are left alone", async () => {
    const named = await person("Priya N. (Sales)", "https://example.com/mine.png");
    await fillNameFromGoogle(await link(named.id, { name: "Priya Nair", picture: "https://lh3.googleusercontent.com/a/p" }));
    expect(await db.user.findUniqueOrThrow({ where: { id: named.id }, select: { name: true, image: true } }))
      .toEqual({ name: "Priya N. (Sales)", image: "https://example.com/mine.png" });
    const other = await person("<prefix>");
    await fillNameFromGoogle(await link(other.id, { name: "Someone" }, "credential"));
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).name).toBe(other.email.split("@")[0]);
  });
});
