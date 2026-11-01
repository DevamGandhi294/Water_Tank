# Build context is the repo root (needs database/migrations):
#   docker build -f backend/Dockerfile .
FROM node:22-alpine AS base
WORKDIR /app/backend
ENV TZ=UTC
COPY backend/package.json backend/package-lock.json ./

# ---- dev: all deps, source is bind-mounted, node --watch
FROM base AS dev
RUN npm ci
COPY database/migrations /app/database/migrations
COPY backend/ ./
CMD ["sh", "-c", "node scripts/migrate.js && node --watch src/index.js"]

# ---- prod
FROM base AS prod
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force
COPY database/migrations /app/database/migrations
COPY backend/scripts ./scripts
COPY backend/src ./src
RUN mkdir -p /srv/ota && chown -R node:node /srv/ota
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["sh", "scripts/docker-start.sh"]
