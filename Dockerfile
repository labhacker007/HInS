# syntax=docker/dockerfile:1
#
# HInS application images — one multi-stage build for the whole npm
# workspace. Infra (Medplum, Keycloak, Postgres, Redis) is NOT built here;
# see infra/docker-compose.yml. Wired up by infra/docker-compose.app.yml.
#
# Targets:
#   web       -> hins-web            (Vite static build served by nginx, port 80)
#   service   -> hins-<name>-service (Fastify service, node:22-alpine, non-root)
#                select with --build-arg SERVICE=consent-service|deid-service|audit-service
#
# The web app's VITE_* values are compiled into the JS bundle at build
# time and are read by the BROWSER, so they must be host-reachable URLs
# (localhost:...), not compose service names.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# Manifests first so `npm ci` is cached across source-only changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/consent-service/package.json services/consent-service/
COPY services/deid-service/package.json services/deid-service/
COPY services/audit-service/package.json services/audit-service/
COPY services/terminology-service/package.json services/terminology-service/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY services services
COPY apps apps
RUN npm run build -w packages/shared \
 && npm run build -w services/consent-service -w services/deid-service -w services/audit-service

# ---------------------------------------------------------------- web build
FROM build AS web-build
ARG VITE_MEDPLUM_BASE_URL=http://localhost:8103/
ARG VITE_MEDPLUM_CLIENT_ID=b62e0e1d-de31-4717-a14d-aa0656e08d6f
ARG VITE_CONSENT_SERVICE_URL=http://localhost:4001
ARG VITE_AUDIT_SERVICE_URL=http://localhost:4005
ENV VITE_MEDPLUM_BASE_URL=${VITE_MEDPLUM_BASE_URL} \
    VITE_MEDPLUM_CLIENT_ID=${VITE_MEDPLUM_CLIENT_ID} \
    VITE_CONSENT_SERVICE_URL=${VITE_CONSENT_SERVICE_URL} \
    VITE_AUDIT_SERVICE_URL=${VITE_AUDIT_SERVICE_URL}
RUN npm run build -w apps/web

# ---------------------------------------------------------------- hins-web
FROM nginx:alpine AS web
RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  server_name _;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  location /assets/ { try_files $uri =404; add_header Cache-Control "public, max-age=31536000, immutable"; }' \
  '  location = /index.html { add_header Cache-Control "no-cache"; }' \
  '  location / { try_files $uri $uri/ /index.html; }' \
  '}' > /etc/nginx/conf.d/default.conf
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

# ---------------------------------------------------------------- service runtime deps
FROM ${NODE_IMAGE} AS service-deps
ARG SERVICE
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/${SERVICE}/package.json services/${SERVICE}/
# Production deps for this one workspace only (plus the @hins/shared symlink).
RUN test -n "${SERVICE}" \
 && npm ci --omit=dev --no-audit --no-fund -w services/${SERVICE} \
 && npm cache clean --force

# ---------------------------------------------------------------- hins-<name>-service
FROM ${NODE_IMAGE} AS service
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=service-deps --chown=node:node /app ./
COPY --from=build --chown=node:node /repo/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /repo/services/${SERVICE}/dist services/${SERVICE}/dist
WORKDIR /app/services/${SERVICE}
USER node
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
