# YouTube transcript acquisition: production decision

Research date: 2026-08-28. Documentation research only; no paid calls, provider benchmarks, OAuth flow, or browser checks performed. Historical runtime evidence comes from `/tmp/trainer-twin-studio-youtube-handoff.md`.

## Recommendation

For predominantly trainer-owned content, prioritize official owner OAuth caption access, conditional on quota, actual channel permissions, and approval of the intended storage/RAG use. Offer owner-supplied original SRT/VTT as the durable alternative; original media plus separately approved transcription is another option if media processing becomes acceptable.

For occasional public videos, TranscriptAPI.com is the more economical **conditional candidate** for existing captions. Supadata is a reasonable alternative if broader platforms or explicitly approved generated transcripts become requirements. Neither vendor is an unconditional production/compliance recommendation: both disclaim guaranteed availability, and vendor access does not grant content or platform rights.

Do not automatically route private/permission-denied OAuth failures to a public extractor. Do not silently enable audio transcription.

## What existing tests establish

- Direct InnerTube/timedtext and `youtube-transcript-api` succeeded locally but failed from AWS Lambda because of YouTube access controls/cloud-IP blocking. A wrapper such as LangChain does not change that acquisition dependency.
- Browser-prefetch remains invalid: the reported successful run used Bun/Node, not Chromium, and therefore did not exercise browser CORS.
- Downstream S3/Neon → queue → chunking/topics/embeddings/Chroma worked once transcript Markdown existed. Preserve that pipeline; replace the acquisition boundary after approval.
- These are handoff findings, not newly reproduced results.

## Official owner access: constraints to resolve

| Concern | Verified documentation and implication |
| --- | --- |
| Access | `captions.download` requires permission to edit the video. Both caption methods document `youtube.force-ssl` or the partner scope, not `youtube.readonly`. OAuth does not authorize arbitrary third-party captions. [List](https://developers.google.com/youtube/v3/docs/captions/list), [download](https://developers.google.com/youtube/v3/docs/captions/download). |
| Quota | Listing costs 50 units; one download costs 200. At the default 10,000-unit shared daily quota, the theoretical ceiling is 40 new one-track videos/day, before overhead. Expansion needs a compliance audit. [Quota process](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits). |
| Coverage | ASR is a documented caption `trackKind`, but owner ASR/private/unlisted coverage still requires a real account pilot. Studio-invited channel delegates cannot access YouTube APIs. [Caption resource](https://developers.google.com/youtube/v3/docs/captions), [channel permissions](https://support.google.com/youtube/answer/9481328?hl=en-gb). |
| OAuth lifecycle | External OAuth projects in Testing normally issue seven-day refresh tokens for these scopes. Plan production consent/scope verification before relying on unattended sync. [OAuth documentation](https://developers.google.com/identity/protocols/oauth2). |

### Policy is a release gate

YouTube Developer Policies III.E.6 prohibit direct or indirect scraping and obtaining scraped YouTube content. III.E.4 generally requires non-statistical authorized data to be refreshed or deleted within 30 days; requested deletion is due within seven days, while Google consent revocation requires deletion within the specified maximum of 30 days. III.E.4.h also contains broad restrictions on derived data. Review transcript retention, embeddings, RAG, and downstream LLM sharing explicitly; this research does not establish that a particular RAG design is permitted or prohibited. A managed extractor does not remove these obligations. [Official policies](https://developers.google.com/youtube/terms/developer-policies?hl=en).

Owner-provided originals avoid the YouTube extraction dependency, but the trainer still needs rights to the supplied content and consent for its processing.

## Managed provider comparison

These are vendor-documented capabilities, not independently measured reliability.

| Area | TranscriptAPI.com | Supadata |
| --- | --- | --- |
| Existing captions | `GET /api/v2/youtube/transcript`; absent captions return 404. | `GET /v1/transcript?mode=native`; avoids generated transcripts. |
| ASR distinction | `asr`/`asr-hi` selects YouTube's existing automatic captions; no provider-generated ASR fallback is documented. | Default `mode=auto` can generate a transcript when native captions are missing. Explicit `native` is mandatory for caption-only ingestion. |
| Timestamps | JSON `start` and `duration` in seconds. | `text=false`: `offset` and `duration` in milliseconds. |
| Language | Priority list; resolved language identifies automatic tracks. Free `/youtube/info` lists available languages. | Requested language can fall back to first available; inspect returned language. |
| Async | No asynchronous transcript-job contract found in reference. | 202 returns `jobId`; polling results expire one hour after completion. |
| Billing behavior | One credit per successful transcript, including cache hits; errors are free. | One native transcript credit; missing-transcript HTTP 206 also costs one credit. Generated transcription costs two credits/minute; job polling is free. |

Sources: [TranscriptAPI reference](https://transcriptapi.com/docs/api/), [Supadata transcript guide](https://docs.supadata.ai/get-transcript).

TranscriptAPI.com is not the similarly named transcriptapi.io: their endpoints and advertised ASR behavior differ. This comparison concerns **.com** only.

### Current USD pricing

| Provider / plan | Included credits | Price | Published rate | Extra credits |
| --- | --- | --- | --- | --- |
| TranscriptAPI monthly | 1,000/month | $5/month | 200/minute | $2.50/1,000 |
| TranscriptAPI annual | 1,000/month | $54/year ($4.50/month equivalent) | 300/minute | $1.50/1,000 |
| Supadata Basic | 300/month | $5/month equivalent; annual-only | 10/second | $10/1,000 |
| Supadata Pro | 3,000/month | $17/month | 10/second | $10/1,000 |
| Supadata Mega | 30,000/month | $47/month | 50/second | $10/5,000 |

Both advertise 100 free credits. Supadata's pricing table also lists Giga: $297/300,000 and Supa: $897/1,000,000; both 100 requests/second and $20/20,000 recharge. Taxes excluded on Supadata. Sources: [TranscriptAPI pricing](https://transcriptapi.com/), [Supadata pricing](https://supadata.ai/pricing).

**Documentation mismatch:** TranscriptAPI's API reference says 300 RPM generally, whereas its pricing page distinguishes 200 monthly versus 300 annual. Budget against the purchased plan and confirm response headers/support before rollout. It documents `Retry-After` for 429 and transient bot/network failures as 408. [Reference](https://transcriptapi.com/docs/api/).

### Private data and availability

- Supadata supports publicly accessible videos only; authentication-required/private/member/age-restricted material is excluded. Do not treat an unlisted link as private protection; confirm support and data handling before sending it. [Accessibility documentation](https://docs.supadata.ai/get-transcript).
- TranscriptAPI.com has no documented owner OAuth credential flow; private access is not verified. Its privacy policy records requested video IDs/query data, retains usage logs up to one year, and typically caches responses for 24–48 hours. It states servers are in Croatia, with some subprocessors outside the EU. [Privacy policy](https://transcriptapi.com/privacy).
- Supadata's privacy policy does not give a clear transcript-content retention/deletion schedule. A one-hour job-result expiry is not proof that all provider copies are deleted. Ask for DPA, subprocessors, retention, and deletion commitments before sensitive data. [Privacy policy](https://supadata.ai/privacy).
- Supadata's standard terms offer best-effort service, permit changes/discontinuation, and disclaim uninterrupted availability. Its public status page is operational telemetry, not a contractual SLA. No binding enterprise SLA was verified. Its terms leave platform-term compliance to the customer and require consent for resale/white-labelling. [Terms](https://supadata.ai/terms), [status](https://status.supadata.ai/).
- TranscriptAPI's standard terms expressly disclaim guaranteed uptime and note dependency on YouTube changes; they preserve YouTube/copyright obligations and restrict resale/redistribution without permission. Confirm that embedding extraction inside a commercial product is covered. [Terms](https://transcriptapi.com/terms/).

## Approval and validation before implementation

1. Resolve platform/content rights and whether stored transcripts, embeddings, and LLM processing fit the permitted use.
2. Pilot official captions against actual owner accounts: manual/ASR, private/unlisted, missing tracks, delegated channels, token refresh, and quota. No universal coverage promise yet.
3. If public managed extraction is approved, pilot TranscriptAPI.com from the deployed region against representative permitted videos; measure missing-caption outcomes, complete timestamps, latency, retries, and provider outages. Use Supadata only with `mode=native` unless ASR is separately approved.
4. Agree transcript-upload and failure UX before code changes. Keep secrets server-side and preserve tenant isolation, provenance, and deletion propagation throughout the existing storage/indexing pipeline.

No application files changed by this research note.
