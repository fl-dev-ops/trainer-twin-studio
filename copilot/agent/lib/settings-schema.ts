import { z } from "zod";

/** The Before settings a twin or role play shows learners before and during the call (the studio checks them again). */
export const beforeSettings = z.object({
  preScreenshare: z.boolean().describe("Learners share their screen for the whole call."),
  preUpload: z.boolean().describe("Learners may add a file before the call."),
  duringUpload: z.boolean().describe("Learners may attach an image during the call."),
  uploadTitle: z.string().max(80).describe("Title of the upload box."),
  uploadInstruction: z.string().max(300).describe("What to upload, as the learner reads it."),
}).partial().strict();
