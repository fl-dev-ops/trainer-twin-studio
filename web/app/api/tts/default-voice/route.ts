import { NextResponse } from "next/server";
import { listAvailableVoices } from "@/lib/voices";

/** Public sample default for older agents without a voice selection. */
export async function GET() {
  const voice = (await listAvailableVoices(null)).find((voice) => voice.kind === "sample");
  if (!voice) return NextResponse.json({ error: "No voices available" }, { status: 404 });
  return NextResponse.json({ voice: { id: voice.id, name: voice.name } });
}
