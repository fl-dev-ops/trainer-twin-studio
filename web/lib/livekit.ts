import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

export function getLiveKitUrl(): string {
  return (
    process.env.NEXT_PUBLIC_LIVEKIT_URL ||
    process.env.LIVEKIT_URL ||
    "ws://localhost:7880"
  );
}

export async function createLiveKitSessionToken({
  sessionId,
  userId,
  userName,
  runtimeToken,
  orgId,
  agentSlug,
}: {
  sessionId: string;
  userId: string;
  userName?: string;
  runtimeToken: string;
  orgId: string;
  agentSlug?: string;
}): Promise<{ url: string; token: string; room: string }> {
  const apiKey = process.env.LIVEKIT_API_KEY || "devkey";
  const apiSecret = process.env.LIVEKIT_API_SECRET || "secret";
  const url = getLiveKitUrl();
  const room = `session-${sessionId}`;
  const identity = `user-${userId}`;

  const metadata = {
    agent_id: agentSlug || "mock_interview",
    user_id: userId,
    sessionId,
    runtimeToken,
    orgId,
    webhook_url: "/api/sessions/webhook",
    interview: {
      type: "mock_interview",
      version: "v1",
    },
  };

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: userName || "Candidate",
    metadata: JSON.stringify(metadata),
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();

  // Explicitly dispatch the LiveKit agent worker to the session room
  const agentName = process.env.LIVEKIT_AGENT_NAME || process.env.AGENT_NAME || "intervoo-agent";
  try {
    const dispatchClient = new AgentDispatchClient(url, apiKey, apiSecret);
    await dispatchClient.createDispatch(room, agentName, {
      metadata: JSON.stringify(metadata),
    });
    console.log(`[LiveKit] Dispatched agent '${agentName}' to room '${room}'`);
  } catch (dispatchErr) {
    console.warn(`[LiveKit] Could not dispatch agent '${agentName}' to room '${room}':`, dispatchErr);
  }

  return { url, token, room };
}
