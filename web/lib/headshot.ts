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

const PROMPT =
  "Turn this into a professional headshot of the same person. Keep their face, features, skin tone, hair, glasses and " +
  "expression exactly; do not change who they are, their age or their body. Business attire that suits them, soft " +
  "studio light, plain neutral background, head and shoulders, centred, square crop, photorealistic.";

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The headshot as image bytes, or throws (no key, gateway error, no image in the reply). */
export async function professionalHeadshot(photo: Uint8Array, mime = "image/jpeg"): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
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
          { type: "text", text: PROMPT },
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
