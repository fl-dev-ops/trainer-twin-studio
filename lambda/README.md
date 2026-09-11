# Lambda: trainertwin-notion-ingestion-prod

This directory contains the code and logic running in the AWS Lambda function **`trainertwin-notion-ingestion-prod`** (`ap-south-1`).

---

## 1. Deployed Lambda Specification

- **Function Name**: `trainertwin-notion-ingestion-prod`
- **Region**: `ap-south-1`
- **Runtime**: `nodejs22.x` (`x86_64`)
- **Handler**: `index.handler`
- **Memory**: 2048 MB
- **Timeout**: 600s (10 min)
- **Role**: `arn:aws:iam::837735292163:role/trainertwin-notion-ingestion-prod`
- **Trigger**: AWS SQS (`arn:aws:sqs:ap-south-1:837735292163:trainertwin-notion-ingestion-prod`)
  - Batch size: 1
  - Max Concurrency: 4
  - DLQ: `trainertwin-notion-ingestion-prod-dlq` (Max receives: 5)
  - Partial batch failure: `ReportBatchItemFailures` enabled
- **EventBridge Schedule**: `rate(2 minutes)` for automatic outbox pump
- **Active Code**: `deployed/index.js` (unpacked directly from the running AWS Lambda deployment zip)

---

## 2. Directory Structure

```
lambda/
├── deployed/
│   └── index.js             # Exact bundled JS file currently active in AWS Lambda
├── src/
│   ├── handler.ts           # Entry point: SQS event processor, job leasing, and retry logic
│   ├── config.ts            # Environment parser & validation
│   ├── knowledge.ts         # ChromaDB per-org database router, S3 operations, and document storage
│   ├── openrouter.ts        # OpenRouter SDK client wrapper
│   ├── message.ts           # SQS message parser (validates { jobId, workItemId })
│   ├── smoke.ts             # Local smoke test runner
│   ├── adapters/
│   │   ├── index.ts         # Adapter registry (notion, youtube, upload)
│   │   ├── types.ts         # Common adapter interfaces
│   │   ├── source-cleaner.ts# S3 & Chroma cleanup helpers
│   │   ├── notion/          # Notion OAuth & public web acquisition, block parser, chunker
│   │   ├── youtube/         # YouTube caption fetching, segmentation, LLM question extraction
│   │   └── upload/          # Direct file upload processing
│   ├── chunking/            # Markdown & text chunking utilities
│   └── topics/              # LLM topic extraction, normalization, and prompts
├── scripts/
│   ├── deploy.sh            # Production deployment script (bun build -> zip -> aws lambda update)
│   ├── lambda-env.ts        # Script generating environment payload for AWS Lambda
│   ├── cleanup-youtube.ts   # Maintenance script
│   └── backfill-notion-topics.ts
├── package.json
└── tsconfig.json
```

---

## 3. Dedicated Chroma Database Routing

Each organization is isolated into its own Chroma database:
- **Database Name**: `orgDatabaseName(orgId)` -> `org_<orgId>`
- **Collection Name**: `"main"` inside each org's database
- **Database Provisioning**: `ensureOrgDatabase` uses Chroma's `AdminCloudClient` to ensure the organization's database exists before collection operations.
- **S3 Bucket**: `trainer-twin-prod` under prefix `trainertwin/kb/{orgId}/...`
