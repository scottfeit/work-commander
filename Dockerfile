# syntax=docker/dockerfile:1
# Builds the dashboard (web + server) into one image. Used for GCP (Cloud Run) and optional local containers.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 10001 wc
ENV NODE_ENV=production \
    WC_WEB_DIST=/app/apps/web/dist \
    WC_DATA_DIR=/home/wc/.work-commander \
    WC_DISABLE_KEYCHAIN=1 \
    PORT=8080
COPY --from=build --chown=wc /app/node_modules ./node_modules
COPY --from=build --chown=wc /app/packages ./packages
COPY --from=build --chown=wc /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=wc /app/apps/server/package.json ./apps/server/
COPY --from=build --chown=wc /app/apps/web/dist ./apps/web/dist
USER wc
WORKDIR /app/apps/server
EXPOSE 8080
CMD ["node", "dist/index.js"]
