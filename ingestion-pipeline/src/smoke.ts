import { handler } from "./handler";
import { parseQueueMessage } from "./message";
import { normalizeNotionId, sanitizeNotionMarkdown } from "./notion";

const message = parseQueueMessage('{"jobId":"job_1","workItemId":"work_1"}');
if (message.workItemId !== "work_1") throw new Error("Message parsing failed");
if (normalizeNotionId("01234567-89ab-cdef-0123-456789abcdef") !== "01234567-89ab-cdef-0123-456789abcdef") throw new Error("Notion ID normalization failed");
if (sanitizeNotionMarkdown("<page url=\"x\">Child</page>\n\nHello") !== "Hello") throw new Error("Markdown sanitization failed");

Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  INGESTION_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/000000000000/smoke",
  DATABASE_URL: "postgresql://smoke:smoke@localhost:5432/smoke",
  S3_BUCKET: "smoke",
  NOTION_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  OPENROUTER_API_KEY: "smoke",
});
const result = await handler({
  Records: [{ messageId: "malformed-smoke", body: "{}", attributes: {} }],
});
if (result.batchItemFailures[0]?.itemIdentifier !== "malformed-smoke") {
  throw new Error("Handler did not reject the malformed SQS record");
}
console.info("ingestion-pipeline smoke passed (no network or database calls)");
