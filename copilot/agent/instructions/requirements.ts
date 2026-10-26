import { defineInstructions } from "eve/instructions";
import { requirementsText } from "../lib/ingest";

// Built once from the same constants the checks use, so the agent knows every limit before its first build.
export default defineInstructions({ content: requirementsText() });
