import { z } from "zod";
import { apiRoute, requireExternalApi } from "@/lib/external-api";
import { grantLearnerCreditsByApi, readLearnerCredits } from "@/lib/external-api-credits";
import { refusals } from "@/lib/errors";
import { MAX_LEARNER_MINUTES } from "@/lib/minutes-config";

type Params = { params: Promise<{ id: string }> };
const grantSchema = z.object({ minutes: z.number().int().min(1).max(MAX_LEARNER_MINUTES), note: z.string().trim().max(200).optional() }).strict();
const keySchema = z.string().trim().min(1).max(128).regex(/^\S+$/);

async function handleGET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "read");
  return Response.json(await readLearnerCredits(api.org.id, (await params).id));
}

async function handlePOST(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  const key = keySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) throw refusals.invalidInput("Send an Idempotency-Key header of 1–128 non-whitespace characters.");
  const parsed = grantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw refusals.invalidInput(`Supply whole minutes from 1 to ${MAX_LEARNER_MINUTES} and an optional note of up to 200 characters.`);
  const result = await grantLearnerCreditsByApi(api, (await params).id, parsed.data, key.data);
  return Response.json(result, { status: result.created ? 201 : 200 });
}

export const GET = apiRoute(handleGET);
export const POST = apiRoute(handlePOST);
