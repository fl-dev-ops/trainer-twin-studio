export type PipelineConfig = {
  awsRegion: string;
  queueUrl: string;
  databaseUrl: string;
  s3Bucket: string;
  s3BasePrefix: string;
  notionApiVersion: string;
  notionTokenEncryptionKey: string;
  chromaUrl: string;
  chromaCloud?: {
    apiKey: string;
    tenant: string;
    database: string;
  };
  openRouterApiKey: string;
  embeddingModel: string;
  topicModel: string;
  topicChunkBatchSize: number;
  maxReceiveCount: number;
  youtubeOAuthClientId: string;
  youtubeOAuthClientSecret: string;
  youtubeTokenEncryptionKey: string;
  youtubeMaintenanceEnabled: boolean;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Reads worker configuration only when a Lambda invocation begins. */
export function loadConfig(): PipelineConfig {
  const chromaApiKey = process.env.CHROMA_API_KEY?.trim();
  return {
    awsRegion: process.env.AWS_REGION?.trim() || "us-east-1",
    queueUrl: required("INGESTION_QUEUE_URL"),
    databaseUrl: required("DATABASE_URL"),
    s3Bucket: required("S3_BUCKET"),
    s3BasePrefix: (process.env.S3_BASE_PREFIX?.trim() || "trainertwin/kb").replace(/^\/+|\/+$/g, ""),
    notionApiVersion: process.env.NOTION_API_VERSION?.trim() || "2026-03-11",
    notionTokenEncryptionKey: process.env.NOTION_TOKEN_ENCRYPTION_KEY?.trim() || "",
    chromaUrl: process.env.CHROMA_URL?.trim() || "http://localhost:8000",
    chromaCloud: chromaApiKey ? {
      apiKey: chromaApiKey,
      tenant: required("CHROMA_TENANT"),
      database: required("CHROMA_DATABASE"),
    } : undefined,
    openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || required("LLM_API_KEY"),
    embeddingModel: process.env.EMBEDDING_MODEL?.trim() || "openai/text-embedding-3-small",
    topicModel: process.env.TOPIC_MODEL?.trim() || "openai/gpt-4o-mini",
    topicChunkBatchSize: positiveInt("TOPIC_CHUNK_BATCH_SIZE", 10),
    maxReceiveCount: positiveInt("INGESTION_MAX_RECEIVE_COUNT", 5),
    youtubeOAuthClientId: process.env.YOUTUBE_OAUTH_CLIENT_ID?.trim() || "",
    youtubeOAuthClientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET?.trim() || "",
    youtubeTokenEncryptionKey: process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY?.trim() || "",
    youtubeMaintenanceEnabled: process.env.YOUTUBE_MAINTENANCE_ENABLED?.trim() === "true",
  };
}
