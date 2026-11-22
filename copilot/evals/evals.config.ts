import { defineEvalConfig } from "eve/evals";

// Copilot evals run against a real model and a real studio (STUDIO_URL); see evals/roleplay-creator.eval.ts.
export default defineEvalConfig({
  maxConcurrency: 2,
  timeoutMs: 15 * 60_000,
});
