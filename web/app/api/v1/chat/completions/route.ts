import { handleCompletions } from "@/lib/runtime/openai";

export async function POST(request: Request) {
  return handleCompletions(request);
}
