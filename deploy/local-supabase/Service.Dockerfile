FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
RUN npm install --global --ignore-scripts pnpm@10.33.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/restore-journal/package.json services/restore-journal/package.json
COPY services/push-provider/package.json services/push-provider/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @lovelies/restore-journal --filter @lovelies/push-provider
COPY services/restore-journal/src services/restore-journal/src
COPY services/push-provider/src services/push-provider/src
COPY services/push-provider/migrations services/push-provider/migrations
COPY deploy/local-supabase/healthcheck.mjs deploy/local-supabase/healthcheck.mjs
COPY deploy/local-supabase/qualify-inside.mjs deploy/local-supabase/qualify-inside.mjs
CMD ["node","services/restore-journal/src/server.mjs"]
