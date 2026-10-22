import { z } from "zod";
import { getTrainerOrg } from "@/lib/org";

export const runtime = "nodejs";
export const maxDuration = 30;

const AI_GATEWAY_BASE_URL = (
  process.env.AI_GATEWAY_BASE_URL ??
  process.env.OPENROUTER_BASE_URL ??
  "https://ai-gateway.vercel.sh/v1"
).replace(/\/$/, "");
const MODEL = process.env.ROLEPLAY_OPENING_MODEL ?? process.env.SPEC_GENERATION_MODEL ?? "google/gemini-2.5-flash";

const inputSchema = z.object({
  clientName: z.string().trim().max(120).optional(),
  scenario: z.string().trim().min(1, "Write the scenario first").max(4000),
  characterRole: z.string().trim().max(60).optional(),
  difficulty: z.string().trim().max(20).optional(),
  howTheyTalk: z.string().trim().max(2000).optional(),
});

/** Drafts the first line a role-play client says, from the scenario and character role. */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });

  const key =
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_OIDC_TOKEN ??
    process.env.OPENROUTER_API_KEY ??
    process.env.LLM_API_KEY;
  if (!key) return Response.json({ error: "Generation is not configured" }, { status: 503 });

  const input = parsed.data;
  const prompt = [
    `Client: ${input.clientName || "the client"}`,
    `Character role: ${input.characterRole ?? "not set"}`,
    `Difficulty: ${input.difficulty ?? "medium"}`,
    input.howTheyTalk ? `How they talk: ${input.howTheyTalk}` : "",
    "",
    "Scenario:",
    input.scenario,
  ].filter((line) => line !== "").join("\n");

  try {
    const res = await fetch(`${AI_GATEWAY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "You write the very first line a client says in a sales role-play phone call. Write it in the client's voice, in natural spoken English, one or two short sentences, at most 30 words. It should voice the client's surface position or objection from the scenario, never their hidden motive. No quotation marks, no stage directions, no names of real companies.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Opening generation failed (${res.status})`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const opening = data.choices?.[0]?.message?.content?.trim().replace(/^["“]|["”]$/g, "");
    if (!opening) throw new Error("Empty opening");
    return Response.json({ opening });
  } catch (error) {
    console.error("[roleplay-opening]", error);
    return Response.json({ error: "Could not generate an opening message, try again" }, { status: 502 });
  }
}
