import { z } from "zod";

/** Gemini accepts -1 for a dynamic budget, or a non-negative integer token count. */
export const thinkingBudgetSchema = z.string().trim().min(1).pipe(z.coerce.number<string>().int().min(-1));
