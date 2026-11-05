import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { modelImage } from "@/lib/model-image";

// Images go to the chat model as pixels; eve only does that up to 3 MiB and 8000 px a side.

test("a small image is passed through as is", async () => {
  const png = await sharp({ create: { width: 780, height: 1712, channels: 3, background: "#fff" } }).png().toBuffer();
  const out = await modelImage(png, "image/png");
  expect(out.mediaType).toBe("image/png");
  expect(Buffer.from(out.data, "base64").equals(png)).toBe(true);
});

test("a large image is resized to fit 2048 px as JPEG, under eve's 3 MiB", async () => {
  // Noise doesn't compress: a 2000x2000 RGB PNG of it is ~12 MB.
  const noise = await sharp(randomBytes(2000 * 2000 * 3), { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
  const tall = await sharp(noise).resize(1400, 5000, { fit: "fill" }).png({ compressionLevel: 0 }).toBuffer();
  expect(tall.byteLength).toBeGreaterThan(2.5 * 1024 * 1024);
  const out = await modelImage(tall, "image/png");
  const bytes = Buffer.from(out.data, "base64");
  const meta = await sharp(bytes).metadata();
  expect(out.mediaType).toBe("image/jpeg");
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(2048);
  expect(bytes.byteLength).toBeLessThan(3 * 1024 * 1024);
});
