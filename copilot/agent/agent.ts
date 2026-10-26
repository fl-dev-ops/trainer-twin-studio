import { defineAgent } from "eve";
import { LIMITS, MODELS } from "./lib/model";

export default defineAgent({
  defaultTools: false,
  tool: false,
  model: MODELS.main.model,
  modelContextWindowTokens: MODELS.main.context,
  reasoning: "low",
  limits: LIMITS,
});
