# Static SPA served by Nginx (non-root).
FROM node:22.12-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @bijliwala/web...
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @bijliwala/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
