import { SignJWT } from "jose";

/**
 * Scoped launch token for the Pipecat agent (plan §2.6): 5-minute HS256 JWT
 * binding an InterviewSession to the learner identity that created it. The
 * agent verifies signature + claims before registering identity on the session.
 * Secret is shared with the agent via AGENT_TOKEN_SECRET.
 */
export async function createAgentLaunchToken(claims: {
  sessionId: string;
  userId: string;
  orgId: string;
  agentSlug: string;
  personaSlug: string;
  contextIds: string[];
}): Promise<string> {
  const secret = process.env.AGENT_TOKEN_SECRET;
  if (!secret) throw new Error("AGENT_TOKEN_SECRET is not configured");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("urn:trainertwin:web")
    .setAudience("urn:trainertwin:agent")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}
