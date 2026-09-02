import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey() {
  const encoded = process.env.NOTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encoded) throw new Error("NOTION_TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("NOTION_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

/** Encrypts a Notion credential with AES-256-GCM before it is persisted. */
export function encryptNotionToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

/** Decrypts a Notion credential only while a server-side job needs it. */
export function decryptNotionToken(payload: string) {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted Notion token");
  const [iv, authTag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
