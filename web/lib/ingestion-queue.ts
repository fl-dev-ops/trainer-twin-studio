import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ingestionMessageSchema, type IngestionMessage } from "@/lib/ingestion-message";

function requiredEnv(name: "AWS_REGION" | "INGESTION_QUEUE_URL") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

let client: SQSClient | undefined;

function queueClient() {
  client ??= new SQSClient({ region: requiredEnv("AWS_REGION") });
  return client;
}

/** Publishes only durable database identifiers; AWS resolves credentials from its default chain. */
export async function publishIngestionMessage(message: IngestionMessage) {
  const payload = ingestionMessageSchema.parse(message);
  await queueClient().send(new SendMessageCommand({
    QueueUrl: requiredEnv("INGESTION_QUEUE_URL"),
    MessageBody: JSON.stringify(payload),
  }));
}
