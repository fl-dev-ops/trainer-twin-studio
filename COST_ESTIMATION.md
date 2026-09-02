# TrainerTwin Ingestion Cost Estimation

This document provides a cost analysis for the TrainerTwin Notion ingestion pipeline, covering the empirical ingestion of a **39-page Notion workspace** (38 indexed markdown documents, 211 vector chunks, 220.5 KB text), unit economics, and scaling projections.

---

## 1. Summary of Ingestion Run (39 Notion Pages)

- **Total Pages Discovered**: 39
- **Total Documents Indexed**: 38 (1 container page without text)
- **Total Vector Chunks Generated**: 211 chunks
- **Total Markdown Stored in S3**: 220,482 bytes (~220.5 KB)
- **Total Pipeline Execution Time**: ~7.7 minutes (concurrent execution across 4 workers)

| Category | Service / Resource | Measured Cost (USD) | % of Total |
| :--- | :--- | :--- | :--- |
| **LLM Classification** | OpenRouter (`openai/gpt-4o-mini`) | $0.01290 | 47.4% |
| **Compute** | AWS Lambda (2048 MB, `ap-south-1`) | $0.01300 | 47.8% |
| **Embeddings** | OpenRouter (`openai/text-embedding-3-small`) | $0.00120 | 4.4% |
| **Storage & Operations** | AWS S3 (`pre-screen-sessions`) | $0.00038 | 1.4% |
| **Message Queue** | AWS SQS (`trainertwin-notion-ingestion-prod`) | $0.00003 | < 0.1% |
| **Vector Store** | Chroma Cloud (Starter Plan) | $0.00000 | 0.0% |
| **Database** | Neon Serverless Postgres (`neondb`) | $0.00000 | 0.0% |
| **Total Cost** | **39 Notion Pages / 38 Documents** | **$0.02751 (~2.75¢)** | **100.0%** |

> **Unit Cost**: **$0.000705 per page** (~0.07¢ per Notion page).

---

## 2. Detailed Service-by-Service Breakdown

### A. OpenRouter (LLM & Embeddings)

#### 1. Topic Classification (`openai/gpt-4o-mini`)
- **Pricing**:
  - Input / Prompt: **$0.15** per 1,000,000 tokens ($0.00015 / 1k tokens)
  - Output / Completion: **$0.60** per 1,000,000 tokens ($0.00060 / 1k tokens)
- **Usage**:
  - 38 documents classified against known & proposed topics.
  - Prompt tokens: ~70,000 tokens $\rightarrow 70,000 \times \$0.00000015 = \$0.01050$
  - Output tokens: ~4,000 tokens $\rightarrow 4,000 \times \$0.00000060 = \$0.00240$
- **Total LLM Cost**: **$0.01290**

#### 2. Vector Embeddings (`openai/text-embedding-3-small`)
- **Pricing**:
  - Input: **$0.02** per 1,000,000 tokens ($0.00002 / 1k tokens)
- **Usage**:
  - 211 text chunks embedded (1536-dimensional vectors).
  - Total tokens: ~60,000 tokens $\rightarrow 60,000 \times \$0.00000002 = \$0.00120$
- **Total Embeddings Cost**: **$0.00120**

---

### B. AWS Infrastructure (`ap-south-1` Mumbai)

#### 1. AWS Lambda (`trainertwin-notion-ingestion-prod`)
- **Configuration**: Node.js 22, 2048 MB (2.0 GB) RAM.
- **Pricing**:
  - Compute: **$0.0000166667** per GB-second.
  - Invocations: **$0.20** per 1,000,000 requests.
  - *Free Tier*: 400,000 GB-seconds and 1M requests per month free.
- **Usage**:
  - Invocations: 39 requests $\rightarrow 39 \times \$0.00000020 = \$0.000008$
  - Runtime: Average ~10.0 seconds per page $\rightarrow 390$ seconds total.
  - Total GB-seconds: $390\text{ s} \times 2.0\text{ GB} = 780\text{ GB-seconds}$.
  - Compute Cost: $780 \times \$0.0000166667 = \$0.01300$.
- **Total Lambda Cost**: **$0.01300** *(or $0.00 with AWS Free Tier)*

#### 2. AWS S3 (`pre-screen-sessions`)
- **Pricing**:
  - Standard Storage: **$0.023** per GB-month.
  - PUT / COPY requests: **$0.005** per 1,000 requests ($0.000005 / request).
  - GET requests: **$0.0004** per 1,000 requests.
- **Usage**:
  - Storage: 220.5 KB $\rightarrow 0.00022\text{ GB} \times \$0.023/\text{month} \approx \$0.000005/\text{month}$.
  - Requests: 38 original PUTs + 38 migration COPYs = 76 write requests $\rightarrow 76 \times \$0.000005 = \$0.00038$.
- **Total S3 Cost**: **$0.00038**

#### 3. AWS SQS (`trainertwin-notion-ingestion-prod`)
- **Pricing**:
  - Standard Queue: **$0.40** per 1,000,000 requests.
  - *Free Tier*: 1,000,000 requests per month free.
- **Usage**:
  - ~39 SendMessage + ~39 ReceiveMessage + ~39 DeleteMessage = ~117 requests.
  - Cost: $117 \times \$0.00000040 = \$0.000047$.
- **Total SQS Cost**: **$0.00005** *(or $0.00 with AWS Free Tier)*

---

### C. Managed Vector & Relational Databases

#### 1. Chroma Cloud
- **Pricing Structure**:
  - Storage: **$0.33** per GiB-month.
  - Writes: **$2.50** per logical GiB.
  - Queries: **$0.0075** per TiB queried.
  - Starter Plan: **$0/month** (includes **$5.00** monthly usage credits).
- **Usage**:
  - 211 vector embeddings written (~0.25 MB logical data).
  - Write cost: $0.00025\text{ GiB} \times \$2.50 = \$0.000625$.
  - Storage cost: $0.00025\text{ GiB} \times \$0.33/\text{mo} = \$0.000083/\text{mo}$.
- **Net Cost**: **$0.00** (fully covered by the $5.00/mo Starter credit).

#### 2. Neon Serverless Postgres
- **Pricing Structure**:
  - Compute: **$0.106** per Compute Unit (CU) hour (Launch Plan).
  - Storage: **$0.35** per GB-month.
  - Free Tier: **100 CU-hours/month** and **0.5 GB** storage free.
  - Scale-to-Zero: Database auto-suspends after 5 minutes of inactivity.
- **Usage**:
  - Ingestion ran for ~7.7 minutes $\rightarrow 0.128\text{ CU-hours}$.
  - Compute cost: $0.128 \times \$0.106 = \$0.01357$.
  - Storage: 38 document rows, 39 page rows, topics (< 1 MB).
- **Net Cost**: **$0.00** (fully covered by the 100 CU-hours/month Free Tier).

---

## 3. Scalability & Cost Projections

Using the empirical baseline of **$0.000705 per Notion page**:

| Ingestion Scale | Discovered Pages | Vector Chunks | Raw Text | Estimated Total Cost |
| :--- | :--- | :--- | :--- | :--- |
| **Small Workspace** | 100 pages | ~550 chunks | ~570 KB | **$0.07** (7¢) |
| **Medium Workspace** | 500 pages | ~2,750 chunks | ~2.8 MB | **$0.35** (35¢) |
| **Large Workspace** | 2,500 pages | ~13,750 chunks | ~14.1 MB | **$1.76** ($1.76) |
| **Enterprise Account** | 10,000 pages | ~55,000 chunks | ~56.4 MB | **$7.05** ($7.05) |
| **Multi-Tenant Scale** | 100,000 pages | ~550,000 chunks | ~564 MB | **$70.50** ($70.50) |

---

## 4. Cost Distribution Analysis

```text
┌────────────────────────────────────────────────────────┐
│               INGESTION COST BREAKDOWN                 │
├──────────────────────────────┬─────────────────────────┤
│ OpenRouter LLM Classification│ ████████████████ (47.4%)│
│ AWS Lambda Compute           │ ████████████████ (47.8%)│
│ OpenRouter Embeddings        │ █ (4.4%)                │
│ AWS S3 Storage & Operations  │ ▍ (1.4%)                │
│ AWS SQS, Chroma, Neon        │ ▏ (< 0.1%)              │
└──────────────────────────────┴─────────────────────────┘
```

---

## 5. Optimization Strategies for Large-Scale Imports

1. **Incremental Syncing (`lastEditedAt`)**:
   - Compare `lastEditedAt` against `KnowledgeDocument.externalUpdatedAt` before fetching child content.
   - Skips LLM classification, embeddings, and S3 uploads for unchanged pages during recurring syncs (cutting re-sync costs by up to 95%).
2. **Batch Topic Classification**:
   - Bundle small Notion container pages or snippets together into a single `gpt-4o-mini` prompt rather than 1 call per page.
3. **Lambda Memory & Concurrency Tuning**:
   - 2048 MB was selected for CPU speed during parsing and TLS connection establishment.
   - Benchmarking 1024 MB vs 2048 MB on production workloads can optimize execution cost per millisecond.
