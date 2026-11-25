import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { studioOrRefusal } from "@/lib/org";
import { orgPrefix, putObject, s3Configured } from "@/lib/s3";
import { liveCardCalibration } from "@/lib/twin/calibration-cards";

/** A spoken answer is short: a few minutes at most. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" };

/**
 * Card calibrations (calibration v2): the coach's spoken answer to a "Feels off". Keeps the recording (S3, under the
 * org) and returns what she said as text, for her to read and edit before saving it with the rating. Deepgram, the
 * same speech-to-text the voice agent uses.
 */
export async function POST(request: Request) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const form = await request.formData().catch(() => null);
  const calibrationId = form?.get("calibrationId");
  const audio = form?.get("audio");
  if (typeof calibrationId !== "string" || !(audio instanceof Blob)) return errorResponse(refusals.invalidInput("calibrationId and audio are required"));
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) return errorResponse(refusals.invalidInput("Record up to a few minutes"));
  const type = audio.type.split(";")[0].trim();
  const extension = EXTENSIONS[type];
  if (!extension) return errorResponse(refusals.invalidInput("That recording format isn't supported"));

  try {
    await liveCardCalibration(org.id, org.user.id, calibrationId);
    const key = process.env.DEEPGRAM_API_KEY?.trim();
    if (!key) throw new AppError("voice_unavailable", "Voice answers aren't set up here (DEEPGRAM_API_KEY). Type your answer instead.", 503);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    // Kept first: the recording matters even if the transcript comes back empty.
    const audioKey = s3Configured ? `${orgPrefix(org.id)}/calibration/${calibrationId}/${Date.now()}-${randomBytes(4).toString("hex")}.${extension}` : null;
    if (audioKey) await putObject(audioKey, bytes, type);
    const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
      method: "POST",
      headers: { authorization: `Token ${key}`, "content-type": type },
      body: bytes,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new AppError("transcription_failed", "Couldn't turn that into text. Try again, or type it.", 502);
    const result = (await response.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
    const text = result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    return NextResponse.json({ text, audioKey });
  } catch (error) {
    return errorResponse(error);
  }
}
