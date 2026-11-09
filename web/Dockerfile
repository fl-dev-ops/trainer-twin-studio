# syntax=docker/dockerfile:1
# Studio web (Next.js). Build context = REPO ROOT, because web imports ../shared (@shared alias, turbopack root "..").
#   docker build -f web/Dockerfile .
# Ignore rules live in web/Dockerfile.dockerignore (BuildKit reads it next to this file; a web/.dockerignore would be
# ignored when the context is the repo root).
FROM node:24-bookworm-slim AS build
RUN npm i -g bun@1
WORKDIR /app
COPY shared ./shared
COPY web ./web
WORKDIR /app/web
RUN bun install --frozen-lockfile
# NEXT_PUBLIC_* are inlined into the client bundle, so they must be present at build time (Dokploy: Build-time args).
ARG NEXT_PUBLIC_BASE_DOMAIN
ARG NEXT_PUBLIC_LIVEKIT_URL
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_AGENT_URL
ARG NEXT_PUBLIC_DOCS_URL
ENV NEXT_PUBLIC_BASE_DOMAIN=$NEXT_PUBLIC_BASE_DOMAIN \
    NEXT_PUBLIC_LIVEKIT_URL=$NEXT_PUBLIC_LIVEKIT_URL \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_AGENT_URL=$NEXT_PUBLIC_AGENT_URL \
    NEXT_PUBLIC_DOCS_URL=$NEXT_PUBLIC_DOCS_URL \
    NEXT_TELEMETRY_DISABLED=1
# env.ts would demand server secrets (DATABASE_URL) at build; they are runtime-only, so skip validation for the build.
RUN SKIP_ENV_VALIDATION=1 bun run build

FROM node:24-bookworm-slim
RUN npm i -g bun@1 && useradd -u 10001 -m app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
WORKDIR /app/web
USER app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "scripts/docker-start.sh"]
