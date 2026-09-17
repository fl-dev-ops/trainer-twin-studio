import {
  AccessToken,
  AgentDispatchClient,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
} from "livekit-server-sdk";

export type LiveKitConfig = {
  url: string;
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
};

export function getLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`LiveKit is not configured: missing ${missing.join(", ")}`);
  const url = env.LIVEKIT_URL!.trim();
  if (!/^wss?:\/\//.test(url)) throw new Error("LIVEKIT_URL must start with ws:// or wss://");
  return {
    url,
    serverUrl: url.replace(/^ws/, "http"),
    apiKey: env.LIVEKIT_API_KEY!.trim(),
    apiSecret: env.LIVEKIT_API_SECRET!.trim(),
    agentName: env.LIVEKIT_AGENT_NAME?.trim() || env.AGENT_NAME?.trim() || "intervoo-agent",
  };
}

function clients() {
  const config = getLiveKitConfig();
  return {
    config,
    rooms: new RoomServiceClient(config.serverUrl, config.apiKey, config.apiSecret),
    dispatches: new AgentDispatchClient(config.serverUrl, config.apiKey, config.apiSecret),
    egress: new EgressClient(config.serverUrl, config.apiKey, config.apiSecret),
  };
}

function recordingOutput(orgId: string, room: string) {
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
  if (!bucket) return null;
  const region = process.env.AWS_REGION || "ap-south-1";
  const prefix = (process.env.S3_BASE_PREFIX || "trainertwin-dev").replace(/^\/+|\/+$/g, "");
  const key = `${prefix}/${orgId}/recordings/${room}/audio.mp4`;
  return {
    key,
    output: new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: key,
      output: {
        case: "s3",
        value: new S3Upload({
          accessKey: process.env.AWS_ACCESS_KEY_ID || "",
          secret: process.env.AWS_SECRET_ACCESS_KEY || "",
          sessionToken: process.env.AWS_SESSION_TOKEN || "",
          region,
          bucket,
        }),
      },
    }),
  };
}

export async function activateLiveKitSession(input: {
  sessionId: string;
  userId: string;
  userName?: string;
  runtimeToken: string;
  orgId: string;
  agentSlug?: string;
  holdOpening?: boolean;
  voice?: string;
}) {
  const { config, rooms, dispatches, egress } = clients();
  const room = input.sessionId;
  const metadata = JSON.stringify({
    sessionId: input.sessionId,
    orgId: input.orgId,
    agentSlug: input.agentSlug,
    runtimeToken: input.runtimeToken,
    hold_opening: Boolean(input.holdOpening),
    ...(input.voice ? { voice: input.voice } : {}),
  });

  if (!(await rooms.listRooms([room])).length) {
    await rooms.createRoom({ name: room, emptyTimeout: 10 * 60, departureTimeout: 30, metadata });
  } else {
    await rooms.updateRoomMetadata(room, metadata);
  }

  const existingDispatch = (await dispatches.listDispatch(room)).find((item) => item.agentName === config.agentName);
  const dispatch = existingDispatch ?? await dispatches.createDispatch(room, config.agentName, { metadata });

  const recording = recordingOutput(input.orgId, room);
  let audioEgressId: string | null = null;
  if (recording) {
    const active = (await egress.listEgress(room)).find((item) => item.status === 0 || item.status === 1 || item.status === 2);
    audioEgressId = active?.egressId ?? (await egress.startRoomCompositeEgress(room, recording.output, { audioOnly: true })).egressId;
  }

  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `user-${input.userId}`,
    name: input.userName || "Candidate",
  });
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });

  return {
    token: await token.toJwt(),
    room,
    dispatchId: dispatch.id,
    audioEgressId,
    audioS3Key: recording?.key ?? null,
  };
}

export async function closeLiveKitSession(input: {
  room: string | null;
  dispatchId?: string | null;
  audioEgressId?: string | null;
  videoEgressId?: string | null;
}) {
  if (!input.room) return;
  const { rooms, dispatches, egress } = clients();
  for (const egressId of [input.audioEgressId, input.videoEgressId].filter((id): id is string => Boolean(id))) {
    await egress.stopEgress(egressId).catch(() => {});
  }
  if (input.dispatchId) await dispatches.deleteDispatch(input.dispatchId, input.room).catch(() => {});
  await rooms.deleteRoom(input.room).catch(() => {});
}
