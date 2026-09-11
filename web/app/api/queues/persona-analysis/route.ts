import { handleCallback } from "@vercel/queue";
import { PersonaAnalysisBusyError, processPersonaAnalysisMessage } from "@/lib/persona-analysis-queue";

export const maxDuration = 300;

const queueHandler = handleCallback(
  async (message) => {
    await processPersonaAnalysisMessage(message);
  },
  {
    visibilityTimeoutSeconds: 300,
    retry: (error, metadata) => {
      if (error instanceof PersonaAnalysisBusyError) {
        return { afterSeconds: 5 };
      }
      if (metadata.deliveryCount >= 3) {
        return { acknowledge: true };
      }
      return { afterSeconds: 15 };
    },
  },
);

export async function POST(request: Request): Promise<Response> {
  return queueHandler(request);
}
