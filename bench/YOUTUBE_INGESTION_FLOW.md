# YouTube Ingestion Flow & Architecture

A concise guide to how YouTube video ingestion, OAuth tokens, caption retrieval, and missing-caption fallbacks work in Trainer Twin Studio.

---

## 1. End-to-End Pipeline Diagram

```
[ 1. Connect Channel (One-Time) ]
Trainer authorizes Google OAuth ──► Server encrypts tokens (AES-256) & saves in PostgreSQL

                                       │
                                       ▼
[ 2. Pre-Flight Preview ]
Trainer enters video URL & clicks "Check video"
  │
  ├──► Next.js server decrypts OAuth token from DB (auto-refreshes if expired)
  └──► Calls YouTube Data API (videos.list + captions.list)
        ├── Verifies channel ownership
        └── Checks if English captions exist
  │
  └──► Returns metadata to UI ("Title • Channel • Creator captions")

                                       │
                                       ▼
[ 3. Enqueue to Queue ]
Trainer clicks "Import video"
  └──► Server creates IngestionJob (queued) and sends IDs-only message to AWS SQS

                                       │
                                       ▼
[ 4. Background Processing (Lambda Worker) ]
Worker reads SQS message ──► Loads connection & decrypts OAuth token from DB
  │
  ├── [ Path A: Captions Available ]
  │     ├── Calls GET /v3/captions/{id}?tfmt=srt with Bearer token
  │     └── Parses SRT into cue-tagged Markdown
  │
  ├── [ Path B: Captions Missing (Fallback) ]
  │     ├── Option 1: Firecrawl /scrape extracts public transcript/audio
  │     └── Option 2: Extract 16kHz MP3 ──► Upload via Sarvam Presigned Batch STT
  │
  ▼
[ 5. Indexing & Storage ]
S3 raw archive ──► Semantic Chunking ──► OpenRouter Embeddings ──► ChromaDB Vector Store
```

---

## 2. Frequently Asked Questions (Q&A)

### Q1: How do we handle YouTube videos when English captions are not available?
**Answer:** Currently, the pipeline **fails fast**:
1. Throws a non-retryable `YouTubeError("NO_ENGLISH_CAPTIONS")`.
2. Marks `KnowledgeSource.status = 'unavailable'`, `IngestionJob.status = 'failed'`.
3. Acknowledges the SQS message to stop unnecessary retries.
4. Alerts the user to add subtitles in YouTube Studio or use an alternate upload.

---

### Q2: How can we get transcriptions when English captions are missing?
**Answer:** We use a multi-tier fallback:
1. **Tier 1 (Official Subtitles):** YouTube Data API (`captions.download`).
2. **Tier 2 (Foreign Subtitles):** Download foreign caption track (e.g. Hindi) and translate to English via LLM while preserving timestamps.
3. **Tier 3 (ASR Model):** Extract audio stream and transcribe using **Sarvam AI Batch Speech-to-Text** (`saaras:v3`).

---

### Q3: How do we send large chunks of audio to Sarvam via APIs?
**Answer:** Through **Sarvam's Batch STT API (`/speech-to-text/job/v1`)** using presigned cloud storage uploads (handles files up to **2 hours**):
1. **Initiate Job:** `POST /job/v1` with model params (`saaras:v3`, `en-IN`).
2. **Get Upload URL:** `POST /job/v1/upload-files` to receive a presigned PUT URL.
3. **Upload Audio:** Directly stream compressed 16kHz mono MP3 (~15MB for 1hr) to the presigned storage URL.
4. **Start & Poll:** `POST /job/v1/{id}/start`, then poll `GET /job/v1/{id}/status` until `Completed`.
5. **Download Results:** Download `0.json` containing text and word/sentence timestamps.

---

### Q4: Can we use Firecrawl to fetch transcripts from YouTube? Why do we store Notion OAuth?
**Answer:**
* **Firecrawl:** Yes, for **public/unlisted** videos. Firecrawl's `/scrape` endpoint can scrape transcripts as Markdown and extract raw MP3 audio streams. It cannot access *private* videos behind login.
* **Why Notion OAuth:** Stored to fetch private Notion workspace pages/databases via the official Notion REST API.
* **Why YouTube OAuth:** Stored to authenticate channel owners so we can import their private/unlisted videos via official Google APIs.

---

### Q5: How is the OAuth token used when fetching transcripts?
**Answer:**
1. Worker decrypts `accessTokenCiphertext` in memory using AES-256-GCM.
2. Checks track list: `GET https://www.googleapis.com/youtube/v3/captions?videoId={ID}` with `Authorization: Bearer <token>`.
3. Downloads SRT track: `GET https://www.googleapis.com/youtube/v3/captions/{CAPTION_ID}?tfmt=srt` with `Authorization: Bearer <token>`.
4. Parses SRT subtitle cues into `[{ startSeconds, endSeconds, text }]`.

---

### Q6: Is OAuth fetched on the client side before starting ingestion?
**Answer:** **No.** The client/browser never sees or stores OAuth tokens:
1. **OAuth:** Done via standard server-side redirect (`/api/youtube/oauth/callback`) and stored encrypted in PostgreSQL.
2. **Check Video Preview:** The browser sends the video URL to Next.js (`POST /api/knowledge/.../youtube { action: "preview" }`). The server uses the stored DB token to verify ownership and captions before letting the user click "Import".
3. **Enqueue:** The browser triggers import, which sends an **identifier-only** message (`{ jobId, sourceId, pageId }`) to SQS.

---

### Q7: Will the token always be ready to use (e.g. importing a video 2 days later)?
**Answer:** **Yes.** 
* The `access_token` expires after 1 hour, but the database holds a long-lived `refresh_token`.
* Whenever a request is made, `createAuthorizedRequests` checks if the token is expired.
* If expired, it automatically calls Google's token endpoint (`grant_type: "refresh_token"`), encrypts the new access token, updates the DB, and completes the request seamlessly.
* *(Note: In Google GCP "Testing" mode, refresh tokens expire in 7 days; in "Production" mode, they remain valid indefinitely).*
