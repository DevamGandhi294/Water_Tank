# Build context: repo root  (docker build -f admin-panel/Dockerfile .)
FROM node:22-alpine AS build
WORKDIR /app
COPY admin-panel/package.json admin-panel/package-lock.json ./
RUN npm ci
COPY admin-panel/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
