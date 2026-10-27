/**
 * A professional headshot from a casual photo, through the AI gateway's image model: same person and face, business
 * attire, studio light, neutral background. People can't be expected to look their best on camera every day; the
 * twin's photo shouldn't depend on it.
 */

const AI_GATEWAY_BASE_URL = (
  process.env.AI_GATEWAY_BASE_URL ??
  process.env.OPENROUTER_BASE_URL ??
  "https://ai-gateway.vercel.sh/v1"
).replace(/\/$/, "");
const AI_GATEWAY_API_KEY =
  process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "";
const HEADSHOT_MODEL = process.env.AVATAR_IMAGE_MODEL ?? "google/gemini-3.1-flash-image";

/** The looks offered side by side after a photo (same person every time; only clothes, light and setting change). */
export const HEADSHOT_STYLES = [
  "wearing a smart black blazer over a plain light top, soft natural daylight, softly blurred bright modern office background",
  "wearing a navy blazer over a white shirt, soft studio light, plain light grey background",
  "wearing a smart-casual knit or open-collar shirt, bright even light, plain white background",
  "wearing smart business clothes, natural daylight outdoors, softly blurred green trees behind",
] as const;

/**
 * Identity first, in the words that worked for Olga's own headshots: name every feature that must stay, ask for a
 * real-photo look, and rule out text, logos and watermarks (casual photos often have screens or graphics behind).
 */
export function headshotPrompt(style = 0) {
  return (
    "This photo shows a real person. Create a photorealistic professional headshot of exactly this person: keep their " +
    "identity, face shape, eyes, nose, mouth, smile, skin tone, age, hair colour, length and texture, and glasses " +
    "(if any) exactly as in the photo. Head and shoulders, facing the camera, warm confident slight smile, " +
    `${HEADSHOT_STYLES[style] ?? HEADSHOT_STYLES[0]}. Square 1:1 portrait, 85mm lens look, realistic skin texture. ` +
    "Ignore any text, graphics or screens in the photo; no text, no logos, no watermark."
  );
}

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The headshot as image bytes, or throws (no key, gateway error, no image in the reply). */
export async function professionalHeadshot(photo: Uint8Array, mime = "image/jpeg", style = 0): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  if (!AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is not configured");
  const res = await fetch(`${AI_GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_GATEWAY_API_KEY}` },
    body: JSON.stringify({
      model: HEADSHOT_MODEL,
      modalities: ["text", "image"],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: headshotPrompt(style) },
          { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(photo).toString("base64")}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Image model returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const url: unknown = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const match = typeof url === "string" ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(url) : null;
  if (!match || !IMAGE_TYPES[match[1]]) throw new Error("The image model returned no image");
  // shortcut: stored as the model returns it (PNG, ~1.5 MB at 1024²); re-encode to JPEG if photo loads get slow.
  return { bytes: new Uint8Array(Buffer.from(match[2], "base64")), mime: match[1], ext: IMAGE_TYPES[match[1]] };
}
