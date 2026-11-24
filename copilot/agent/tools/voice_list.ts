import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the voice library (read-only): id, name, own (this organization's) or shared, and each voice's language (ISO code: the one it sounds native in; 30 languages), gender, age (young, middle-aged, older) and accent. Call before persona_create or a voice change in persona_update. When the trainer hasn't named a voice, pick the one whose gender, age and accent best fit the person and say why it is a proposal. Voices are only ever chosen by id: never create, copy or rename one.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listVoices" });
  },
});
