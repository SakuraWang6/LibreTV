# ---- 构建阶段 ----
FROM node:22-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS builder
COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=768
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Optional regional Alpine mirror; apk still verifies the repository signatures.
ARG ALPINE_MIRROR
# Web and the independent download worker share this image and a persistent volume.
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR%/}|g" /etc/apk/repositories; \
    fi \
    && apk add --no-cache ffmpeg \
    && mkdir -p /data/library && chown -R node:node /data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/node_modules/typescript ./node_modules/typescript

USER node

EXPOSE 8080
CMD ["node", "server.js"]
