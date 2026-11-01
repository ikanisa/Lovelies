FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
RUN npm install --global --ignore-scripts pnpm@10.33.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/supabase-api/package.json services/supabase-api/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @lovelies/supabase-api
COPY services/supabase-api/src services/supabase-api/src
COPY services/supabase-api/scripts services/supabase-api/scripts
COPY scripts/local-supabase-managed-auth-rotation-core.mjs scripts/local-supabase-managed-auth-rotation-worker.mjs scripts/local-supabase-lifecycle.mjs scripts/local-supabase-operator-entry.mjs scripts/
COPY deploy/local-supabase/functions-main/lifecycle-gate.mjs deploy/local-supabase/functions-main/lifecycle-gate.mjs
ENTRYPOINT ["node","--experimental-transform-types","scripts/local-supabase-operator-entry.mjs"]
