import { defineState } from "eve/context";
import type { SessionPlanState } from "./session-plan";

export const planState = defineState<SessionPlanState | null>("trainertwin.session_plan", () => null);
