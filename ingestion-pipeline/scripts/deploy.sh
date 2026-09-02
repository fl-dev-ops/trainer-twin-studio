#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PIPELINE_ENV_FILE="${PIPELINE_ENV_FILE:-.env}"
FUNCTION_NAME="${FUNCTION_NAME:-trainertwin-notion-ingestion-prod}"
REGION="${AWS_REGION:-$(bun --env-file="$PIPELINE_ENV_FILE" -e 'process.stdout.write(process.env.AWS_REGION || "us-east-1")')}"
INGESTION_QUEUE_URL="${INGESTION_QUEUE_URL:-$(bun --env-file="$PIPELINE_ENV_FILE" -e 'process.stdout.write(process.env.INGESTION_QUEUE_URL || "")')}"
: "${INGESTION_QUEUE_URL:?Set INGESTION_QUEUE_URL in the worker environment file}"
LAMBDA_ROLE_ARN="${LAMBDA_ROLE_ARN:-$(aws iam get-role --role-name "$FUNCTION_NAME" --query Role.Arn --output text)}"

TIMEOUT_SECONDS="${LAMBDA_TIMEOUT_SECONDS:-600}"
VISIBILITY_SECONDS="${SQS_VISIBILITY_TIMEOUT_SECONDS:-3600}"
MAX_CONCURRENCY="${SQS_MAX_CONCURRENCY:-4}"
MAX_RECEIVES="${SQS_MAX_RECEIVE_COUNT:-5}"
MEMORY_MB="${LAMBDA_MEMORY_MB:-2048}"
DLQ_NAME="${DLQ_NAME:-${FUNCTION_NAME}-dlq}"

umask 077
LAMBDA_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/trainertwin-lambda-env.XXXXXX")"
trap 'rm -f "$LAMBDA_ENV_FILE"' EXIT
bun --env-file="$PIPELINE_ENV_FILE" scripts/lambda-env.ts "$LAMBDA_ENV_FILE"

bun run build
mkdir -p dist
(cd dist && zip -q lambda.zip index.js)

DLQ_URL="$(aws sqs create-queue --region "$REGION" --queue-name "$DLQ_NAME" --query QueueUrl --output text)"
DLQ_ARN="$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
QUEUE_ARN="$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$INGESTION_QUEUE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
REDRIVE_POLICY="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "$DLQ_ARN" "$MAX_RECEIVES")"
ATTRIBUTES_JSON="$(bun -e 'console.log(JSON.stringify({ VisibilityTimeout: process.argv[1], RedrivePolicy: process.argv[2] }))' "$VISIBILITY_SECONDS" "$REDRIVE_POLICY")"
aws sqs set-queue-attributes --region "$REGION" --queue-url "$INGESTION_QUEUE_URL" --attributes "$ATTRIBUTES_JSON"

VPC_ARGS=()
if [[ -n "${VPC_SUBNET_IDS:-}" || -n "${VPC_SECURITY_GROUP_IDS:-}" ]]; then
  : "${VPC_SUBNET_IDS:?Set VPC_SUBNET_IDS when configuring a VPC}"
  : "${VPC_SECURITY_GROUP_IDS:?Set VPC_SECURITY_GROUP_IDS when configuring a VPC}"
  VPC_ARGS=(--vpc-config "SubnetIds=$VPC_SUBNET_IDS,SecurityGroupIds=$VPC_SECURITY_GROUP_IDS")
fi

FUNCTION_EXISTS="$(aws lambda list-functions --region "$REGION" --query "length(Functions[?FunctionName=='$FUNCTION_NAME'])" --output text)"
if [[ "$FUNCTION_EXISTS" != "0" ]]; then
  aws lambda update-function-code --region "$REGION" --function-name "$FUNCTION_NAME" --zip-file fileb://dist/lambda.zip >/dev/null
  aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME"
  if [[ ${#VPC_ARGS[@]} -gt 0 ]]; then
    aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" --handler index.handler --timeout "$TIMEOUT_SECONDS" --memory-size "$MEMORY_MB" --environment "file://$LAMBDA_ENV_FILE" "${VPC_ARGS[@]}" >/dev/null
  else
    aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" --handler index.handler --timeout "$TIMEOUT_SECONDS" --memory-size "$MEMORY_MB" --environment "file://$LAMBDA_ENV_FILE" >/dev/null
  fi
  aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME"
else
  if [[ ${#VPC_ARGS[@]} -gt 0 ]]; then
    aws lambda create-function --region "$REGION" --function-name "$FUNCTION_NAME" --runtime nodejs22.x --role "$LAMBDA_ROLE_ARN" --handler index.handler --timeout "$TIMEOUT_SECONDS" --memory-size "$MEMORY_MB" --environment "file://$LAMBDA_ENV_FILE" "${VPC_ARGS[@]}" --zip-file fileb://dist/lambda.zip >/dev/null
  else
    aws lambda create-function --region "$REGION" --function-name "$FUNCTION_NAME" --runtime nodejs22.x --role "$LAMBDA_ROLE_ARN" --handler index.handler --timeout "$TIMEOUT_SECONDS" --memory-size "$MEMORY_MB" --environment "file://$LAMBDA_ENV_FILE" --zip-file fileb://dist/lambda.zip >/dev/null
  fi
fi
aws lambda wait function-active-v2 --region "$REGION" --function-name "$FUNCTION_NAME"

MAPPING_UUID="$(aws lambda list-event-source-mappings --region "$REGION" --function-name "$FUNCTION_NAME" --event-source-arn "$QUEUE_ARN" --query 'EventSourceMappings[0].UUID' --output text)"
SCALING_CONFIG="{\"MaximumConcurrency\":$MAX_CONCURRENCY}"
if [[ "$MAPPING_UUID" == "None" || -z "$MAPPING_UUID" ]]; then
  aws lambda create-event-source-mapping --region "$REGION" --function-name "$FUNCTION_NAME" --event-source-arn "$QUEUE_ARN" --batch-size 1 --maximum-batching-window-in-seconds 0 --function-response-types ReportBatchItemFailures --scaling-config "$SCALING_CONFIG" >/dev/null
else
  aws lambda update-event-source-mapping --region "$REGION" --uuid "$MAPPING_UUID" --batch-size 1 --maximum-batching-window-in-seconds 0 --function-response-types ReportBatchItemFailures --scaling-config "$SCALING_CONFIG" >/dev/null
fi

echo "Deployed $FUNCTION_NAME: batch=1 timeout=${TIMEOUT_SECONDS}s visibility=${VISIBILITY_SECONDS}s concurrency=$MAX_CONCURRENCY dlq=$DLQ_NAME maxReceives=$MAX_RECEIVES"
