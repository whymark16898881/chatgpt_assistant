# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
# .dockerignore is an explicit source allowlist, excluding NAS data and credentials.
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOST=0.0.0.0 PORT=3000 CFO_DATA_DIR=/data/originals CFO_DB_PASSWORD_FILE=/run/cfo/db-password CFO_WEB_PASSWORD_FILE=/run/cfo/web-password
CMD ["node","server.mjs"]
