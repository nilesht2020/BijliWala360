# Multi-stage image for the API and the worker (same code, different entry point).
#   docker build -f infra/docker/api.Dockerfile -t bijliwala-api .
#   API:    docker run bijliwala-api
#   Worker: docker run bijliwala-api node dist/worker.js
FROM node:22.12-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile --filter @bijliwala/api...
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @bijliwala/contracts build && pnpm --filter @bijliwala/api build
RUN pnpm --filter @bijliwala/api deploy --prod --legacy /out

FROM node:22.12-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health/live || exit 1
CMD ["node", "dist/main.js"]
