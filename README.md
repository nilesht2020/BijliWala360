# SkillConnect

B2B service marketplace: companies source verified individual professionals and vendor workforces,
with **admin-controlled allocation**, one-time provider registration fees, and online (Razorpay) plus
offline business payments with full reconciliation.

| Document | Purpose |
|---|---|
| [docs/SRS.md](docs/SRS.md) | Requirements |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modular monolith design, concurrency and payment flows |
| [docs/DATABASE.md](docs/DATABASE.md) | Collections, indexes, transaction boundaries |
| [docs/API.md](docs/API.md) | REST contract, permissions, error codes |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | Phased delivery plan and progress |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Test strategy and critical scenarios |

## Repository layout

```
apps/api            NestJS backend: HTTP API (src/main.ts) and worker process (src/worker.ts)
apps/web            React + Vite SPA (public site, company, provider and admin portals)
packages/contracts  Shared Zod schemas, enums, error codes, permissions, business-config registry
packages/tsconfig   Strict TypeScript bases
infra/              Docker Compose (dev dependencies), Dockerfiles, Nginx config
```

## Prerequisites

- Node.js 22+ and pnpm 10 (`corepack enable`)
- Docker (for MongoDB replica set, Redis, MinIO, ClamAV, Mailpit). Tests do **not** need Docker:
  integration tests start an in-memory MongoDB replica set and mock Redis.

## Getting started

```bash
pnpm install
cp .env.example .env                 # then fill in the generated secrets (see comments in the file)
docker compose -f infra/compose/docker-compose.dev.yml up -d
pnpm build:contracts

pnpm dev:api      # http://localhost:3000  (Swagger: /api/docs, health: /health/ready)
pnpm dev:worker   # outbox relay + background jobs
pnpm dev:web      # http://localhost:5173  (proxies /api to the API)
```

Create the first Super Admin. The credentials come from environment variables rather than command-line
arguments, and two-factor setup happens on first sign-in at `/admin/login`:

```bash
pnpm --filter @skillconnect/api build
ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-password-123' \
  pnpm --filter @skillconnect/api cli:create-admin
```

In development, SMS and email go to the console adapters, so OTP codes and password links appear in
the API log.

**Fixed development OTP:** with `DEV_FIXED_OTP=123456` in `.env`, every mobile sign-in code is `123456`
and the sign-in page shows it with a "Use it" button. Remove the variable once a real SMS provider is
integrated; the API refuses to start in production while it is set.

**Without Docker** (no Redis, MinIO or ClamAV), set these in `.env`. Each one is refused in production:
`QUEUE_MODE=inline` runs background jobs inside the API, `STORAGE_DRIVER=local` stores uploads in
`.local-storage/`, and `SCANNER=none` skips antivirus but still checks real file types. With no Razorpay
keys configured, a fake gateway is used, and the provider's "Pay online" step completes through a simulator.

Release step for databases (indexes are declared on the Mongoose schemas; production runs with
`autoIndex` off):

```bash
pnpm --filter @skillconnect/api build && pnpm --filter @skillconnect/api db:sync-indexes
```

## Quality gates

```bash
pnpm exec eslint apps/api/src apps/api/test apps/web/src packages/contracts/src
pnpm format:check
pnpm typecheck
pnpm --filter @skillconnect/contracts test
pnpm --filter @skillconnect/api test        # unit + integration (in-memory replica set)
pnpm --filter @skillconnect/web test
```

## Conventions (short version)

- Responses: `{ success: true, data, meta? }` / `{ success: false, error: { code, message, details? }, requestId }`.
- Money is **integer paise**; calendar dates are `YYYY-MM-DD` site-local; shifts are minutes from midnight.
- Business settings (fees, windows, weights, thresholds) come from the business-config store, never constants.
- Multi-document and financial writes go through `TransactionRunner`; side effects go through the outbox.
- Mutations that move money or allocate people require an `Idempotency-Key` header.
