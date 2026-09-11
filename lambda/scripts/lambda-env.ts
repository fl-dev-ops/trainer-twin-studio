import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";

const destination = process.argv[2];
if (!destination) throw new Error("Expected a private output path for Lambda environment JSON");

const config = loadConfig();
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (localHosts.has(new URL(config.databaseUrl).hostname)) {
  throw new Error("Lambda DATABASE_URL must point to a reachable database, not localhost");
}
if (!config.chromaCloud && localHosts.has(new URL(config.chromaUrl).hostname)) {
  throw new Error("Configure Chroma Cloud or a Lambda-reachable CHROMA_URL");
}

// Explicit allowlist: never deploy AWS credentials or unrelated web/auth secrets.
const Variables = {
  DATABASE_URL: config.databaseUrl,
  INGESTION_QUEUE_URL: config.queueUrl,
  S3_BUCKET: config.s3Bucket,
  S3_BASE_PREFIX: config.s3BasePrefix,
  NOTION_API_VERSION: config.notionApiVersion,
  NOTION_TOKEN_ENCRYPTION_KEY: config.notionTokenEncryptionKey,
  CHROMA_URL: config.chromaUrl,
  ...(config.chromaCloud ? {
    CHROMA_API_KEY: config.chromaCloud.apiKey,
    CHROMA_TENANT: config.chromaCloud.tenant,
    CHROMA_DATABASE: config.chromaCloud.database,
  } : {}),
  OPENROUTER_API_KEY: config.openRouterApiKey,
  EMBEDDING_MODEL: config.embeddingModel,
  TOPIC_MODEL: config.topicModel,
  TOPIC_CHUNK_BATCH_SIZE: String(config.topicChunkBatchSize),
  INGESTION_MAX_RECEIVE_COUNT: String(config.maxReceiveCount),
  YOUTUBE_OAUTH_CLIENT_ID: config.youtubeOAuthClientId,
  YOUTUBE_OAUTH_CLIENT_SECRET: config.youtubeOAuthClientSecret,
  YOUTUBE_TOKEN_ENCRYPTION_KEY: config.youtubeTokenEncryptionKey,
  YOUTUBE_MAINTENANCE_ENABLED: String(config.youtubeMaintenanceEnabled),
};

writeFileSync(destination, JSON.stringify({ Variables }), { mode: 0o600 });
console.info(`[JOB:lambda-deploy] environment prepared keys=${Object.keys(Variables).length}`);
