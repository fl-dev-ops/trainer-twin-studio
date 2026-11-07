import { defineAgent, defineDynamic } from "eve";
import { CHAT_MODEL, cerebrasModel, cerebrasProviderOptions } from "./lib/cerebras";

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const attributes = (ctx.session.auth.current?.attributes ?? {}) as Record<string, string | undefined>;
        return {
          model: cerebrasModel(CHAT_MODEL),
          modelOptions: { providerOptions: cerebrasProviderOptions(attributes.reasoningEffort) },
        };
      },
    },
  }),
  limits: {
    sessionUsage: () => false,
    sessionTimeoutMs: false,
  },
});
