import { NextResponse } from "next/server";
import { documentToMarkdown } from "@/lib/documents";

const MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    const { markdown } = await documentToMarkdown(file, MAX_CHAT_ATTACHMENT_BYTES);
    return NextResponse.json({ filename: file.name, mediaType: "text/markdown", markdown });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Document conversion failed" },
      { status: 400 },
    );
  }
}
