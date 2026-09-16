import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { TokenVerifier } from "livekit-server-sdk";
import { getLiveKitConfig } from "@/lib/livekit";

const WHITEBOARD_CONTENT_TYPE = "image/png";
const WHITEBOARD_UPLOAD_EXPIRES_SECONDS = 60;

type WhiteboardObject = {
  roomName: string;
  questionId: string;
  imageSha256: string;
  imageBytes: number;
};

function requiredBucket(): string {
  const value = process.env.S3_BUCKET?.trim() || process.env.AWS_S3_BUCKET?.trim();
  if (!value) throw new Error("S3_BUCKET is required for whiteboard uploads");
  return value;
}

function createS3Client(): S3Client {
  const endpoint = process.env.AWS_S3_ENDPOINT?.trim();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together");
  }
  return new S3Client({
    region: process.env.AWS_REGION?.trim() || "us-east-1",
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: ["1", "true", "yes"].includes(
      process.env.AWS_S3_FORCE_PATH_STYLE?.toLowerCase() ?? "",
    ),
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
}

function isSafeRoomName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

function isSafeQuestionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._#-]{0,239}$/.test(value);
}

export function validateWhiteboardObject(input: WhiteboardObject): boolean {
  return (
    isSafeRoomName(input.roomName) &&
    isSafeQuestionId(input.questionId) &&
    /^[a-f0-9]{64}$/.test(input.imageSha256) &&
    Number.isInteger(input.imageBytes) &&
    input.imageBytes > 0 &&
    input.imageBytes <= 4 * 1024 * 1024
  );
}

export async function verifyParticipantRequest(
  request: Request,
  roomName: string,
  participantIdentity: string,
): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  try {
    const { apiKey, apiSecret } = getLiveKitConfig();
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      authorization.slice("Bearer ".length),
    );
    return (
      claims.sub === participantIdentity &&
      claims.video?.roomJoin === true &&
      claims.video.room === roomName
    );
  } catch {
    return false;
  }
}

export function whiteboardSigningSecret(): string {
  return process.env.WHITEBOARD_EVALUATION_SIGNING_SECRET?.trim() || getLiveKitConfig().apiSecret;
}

export function buildWhiteboardS3Key(
  input: Pick<WhiteboardObject, "roomName" | "questionId" | "imageSha256">,
  now = new Date(),
): string {
  const datePath = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("/");
  const basePrefix = process.env.S3_BASE_PREFIX?.trim() || "trainertwin-dev";
  return `${basePrefix}/interview-sessions/${datePath}/${input.roomName}/whiteboards/${input.questionId}-${input.imageSha256.slice(0, 12)}.png`;
}

export async function createWhiteboardUpload(input: WhiteboardObject) {
  const s3Key = buildWhiteboardS3Key(input);
  const uploadUrl = await getSignedUrl(
    createS3Client(),
    new PutObjectCommand({
      Bucket: requiredBucket(),
      Key: s3Key,
      ContentType: WHITEBOARD_CONTENT_TYPE,
      Metadata: { sha256: input.imageSha256 },
    }),
    { expiresIn: WHITEBOARD_UPLOAD_EXPIRES_SECONDS },
  );
  return {
    s3Key,
    uploadUrl,
    headers: { "content-type": WHITEBOARD_CONTENT_TYPE },
  };
}

export async function readWhiteboardUpload(
  input: WhiteboardObject & { s3Key: string },
): Promise<Uint8Array | null> {
  if (input.s3Key !== buildWhiteboardS3Key(input, keyDate(input.s3Key))) return null;

  const startedAt = Date.now();
  console.info(`[EXT-API:s3-whiteboard] download_started question_id=${input.questionId}`);
  try {
    const result = await createS3Client().send(
      new GetObjectCommand({ Bucket: requiredBucket(), Key: input.s3Key }),
    );
    if (
      result.ContentType !== WHITEBOARD_CONTENT_TYPE ||
      result.ContentLength !== input.imageBytes ||
      result.Metadata?.sha256 !== input.imageSha256 ||
      !result.Body
    ) {
      return null;
    }
    const imageBytes = await result.Body.transformToByteArray();
    const actualHash = createHash("sha256").update(imageBytes).digest("hex");
    if (imageBytes.byteLength !== input.imageBytes || actualHash !== input.imageSha256) return null;
    console.info(
      `[EXT-API:s3-whiteboard] download_completed question_id=${input.questionId} bytes=${imageBytes.byteLength} elapsed_ms=${Date.now() - startedAt}`,
    );
    return imageBytes;
  } catch (error) {
    console.error(
      `[EXT-API:s3-whiteboard] download_failed question_id=${input.questionId} elapsed_ms=${Date.now() - startedAt}`,
      error,
    );
    return null;
  }
}

function keyDate(s3Key: string): Date {
  const match = s3Key.match(/\/interview-sessions\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!match) return new Date(Number.NaN);
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
}
