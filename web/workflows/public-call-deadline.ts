import { sleep } from "workflow";
import { expirePublicCall } from "./steps/public-call-deadline";

export async function publicCallDeadline(sessionId: string, endsAt: string) {
  "use workflow";
  await sleep(new Date(endsAt));
  await expirePublicCall(sessionId);
}
