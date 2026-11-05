import sharp from "sharp";

/**
 * eve hands a tool-returned image to the model as pixels only up to 3 MiB and 8000 px a side (larger ones reach it as
 * a file label). Uploads may be 10 MB: an image over the margin below is resized to fit 2048 px and re-encoded as JPEG
 * (the model downsamples large images anyway; screenshot text stays readable at that size).
 */
const MAX_BYTES = 2.5 * 1024 * 1024;
const MAX_SIDE = 4096;
const FIT = 2048;

/** An uploaded image (PNG, JPEG or WebP) as base64 the chat model can look at. */
export async function modelImage(content: Uint8Array, mediaType: string): Promise<{ mediaType: string; data: string }> {
  const bytes = Buffer.from(content);
  const { width = 0, height = 0 } = await sharp(bytes).metadata();
  if (bytes.byteLength <= MAX_BYTES && Math.max(width, height) <= MAX_SIDE) return { mediaType, data: bytes.toString("base64") };
  const resized = await sharp(bytes).rotate().resize({ width: FIT, height: FIT, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { mediaType: "image/jpeg", data: resized.toString("base64") };
}
