FROM node:24-bookworm
RUN npm i -g bun@1
WORKDIR /app
COPY shared ./shared
COPY web ./web
WORKDIR /app/web
RUN bun install --frozen-lockfile
ARG NEXT_PUBLIC_BASE_DOMAIN
ENV NEXT_PUBLIC_BASE_DOMAIN=$NEXT_PUBLIC_BASE_DOMAIN NEXT_TELEMETRY_DISABLED=1
RUN bun run build
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
