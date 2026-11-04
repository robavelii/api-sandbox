# One image for the API, worker, dashboard and migrations; compose picks the command.
FROM node:24-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/engine/package.json packages/engine/
# Dev dependencies stay: migrations run through tsx.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# Compiled into the dashboard bundle, so it is a build argument, not runtime env.
ARG NEXT_PUBLIC_RUNTIME_URL
ENV NEXT_PUBLIC_RUNTIME_URL=$NEXT_PUBLIC_RUNTIME_URL
RUN npm run build && chown -R node:node apps/web/.next
ENV NODE_ENV=production
USER node
