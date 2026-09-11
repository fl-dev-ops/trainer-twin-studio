import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

type LiveKitConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
};

export function getLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter(
    (key) => !env[key]?.trim(),
  );
  if (missing.length) throw new Error(`LiveKit is not configured: missing ${missing.join(", ")}`);

  const url = env.LIVEKIT_URL!.trim();
  if (!/^wss?:\/\//.test(url)) throw new Error("LIVEKIT_URL must start with ws:// or wss://");

  return {
    url,
    apiKey: env.LIVEKIT_API_KEY!.trim(),
    apiSecret: env.LIVEKIT_API_SECRET!.trim(),
    agentName: env.LIVEKIT_AGENT_NAME?.trim() || env.AGENT_NAME?.trim() || "intervoo-agent",
  };
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
  const { url, apiKey, apiSecret, agentName } = getLiveKitConfig();
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

  // UNVERIFIED (no LiveKit Docs MCP): checked against the current docs and installed v2.19.0 types.
  const dispatchClient = new AgentDispatchClient(url, apiKey, apiSecret);
  await dispatchClient.createDispatch(room, agentName, {
    metadata: JSON.stringify(metadata),
  });

  return { url, token, room };
}
