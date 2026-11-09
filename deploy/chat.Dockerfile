FROM node:24-bookworm
RUN npm i -g bun@1
WORKDIR /app/chat
COPY chat ./
RUN bun install --frozen-lockfile && node_modules/.bin/eve build
EXPOSE 2000
CMD ["node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "2000"]
