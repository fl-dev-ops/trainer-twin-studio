import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

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
  holdOpening = false,
}: {
  sessionId: string;
  userId: string;
  userName?: string;
  runtimeToken: string;
  orgId: string;
  agentSlug?: string;
  /** When true the agent worker holds its greeting until the client sends "begin-opening". */
  holdOpening?: boolean;
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
    interview: {
      type: "mock_interview",
      version: "v1",
    },
    hold_opening: holdOpening,
  };

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: userName || "Candidate",
    metadata: JSON.stringify(metadata),
  });

  at.addGrant({
    roomJoin: true,
    room,
    roomCreate: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const dispatchMeta = JSON.stringify(metadata);
  at.roomConfig = new RoomConfiguration({
    name: room,
    metadata: dispatchMeta,
    agents: [
      new RoomAgentDispatch({
        agentName,
        metadata: dispatchMeta,
      }),
    ],
  });

  return { url, token: await at.toJwt(), room };
}
