---
name: new-backend-module
description: Add a new NestJS business module (or a big feature in an existing one) to the Bijli Wala API following the repo's conventions - shared Zod contracts, permissions, Mongoose schema, audit/outbox/transactions, app.module registration, integration tests and doc updates. Use when building any backend feature from docs/DEVELOPMENT_PLAN.md (work orders, payroll, advertising, CMS, geography, departments, attendance...).
---

# New backend module

Before writing code, read the design for the feature:
- **SRS:** the `FR-*` IDs in `docs/SRS.md`.
- **Collections:** `docs/DATABASE.md`. §15 covers the v2 modules.
- **Endpoints:** `docs/API.md` §4.x.
- **Architecture:** `docs/ARCHITECTURE.md`. §6 covers the mechanisms and §11 the v2 modules.

The source of truth is the requirement document `docs/bijli wala .docx`. The SRS maps it onto the code.

Use an existing module as the template. `apps/api/src/modules/plans/plans.module.ts` is small. `quotations/quotations.module.ts` covers transactions, PDF and outbox. Most modules keep the schema, service and controllers in **one `*.module.ts` file**, and split out `schemas.ts` / `*.service.ts` / `domain/` once they grow.

## Checklist

### 1. Contracts (`packages/contracts/src`)
- Add a file for the domain (for example `work-orders.ts`) and export it from `index.ts`. It holds:
  - the request schemas (`z.object(...).strict()`), view types and status enums (`as const` arrays + types).
- Add new permission codes to `permissions.ts` (`PERMISSIONS` array) and grant them to system roles in `roles.ts`.
- Add new error codes to `error-codes.ts`.
- Business values (prefixes, windows, thresholds, prices) go in the `business-config.ts` registry with a Zod schema and default. **Never hardcode them.**
- Money is integer **paise**, dates are `YYYY-MM-DD`, shifts are minutes from midnight.
- Run `pnpm build:contracts`.

### 2. Module (`apps/api/src/modules/<name>/`)
- **Mongoose schema:**
  - `collection: '<snake_plural>'`, `timestamps: true`, `versionKey: false`.
  - `version: Number` for optimistic concurrency, and `createdBy` / `updatedBy`.
  - Indexes declared on the schema (production syncs them with `db:sync-indexes`).
- **Controllers:**
  - `@RequirePermissions('x.y')` on every route; `@Public()` only for genuinely public routes.
  - `@CurrentUser()` for the actor.
  - Validate input with `createZodDto(schema)` / `ApiZodBody`.
- **Scope:** non-platform users must only see their own records. Always add `companyId` / `vendorId` / owner filters in queries, and return `NotFoundError` (404) for other tenants' records. Never 403-leak existence.
- **State changes:** use a conditional `updateOne({_id, status: from, version}, {$set..., $inc:{version:1}})`. If `matchedCount === 0`, return 409.
- **Multi-document or money writes:** run them through `TransactionRunner` and pass `session` everywhere.
- **Side effects:** notifications and events go through the outbox in the same transaction, never inline.
- **Audit:** call `AuditService` for every state change (`actorFromUser`).
- **Idempotency:** mutations that move money or allocate people require the `Idempotency-Key` header (idempotency interceptor).
- **Human-readable numbers:** use the `counters` sequence with a config prefix.
- **Registration:** register the module in `apps/api/src/app.module.ts`. If it has background jobs or outbox consumers, also register it in `background.module.ts`.

### 3. Tests
- **Pure logic** (state machines, calculators): unit spec next to the code (`*.spec.ts`).
- **HTTP flows:** `apps/api/test/modules/<area>.int-spec.ts`, using `createTestApp` from `test/setup/harness.ts` and the helpers in `test/setup/auth-helpers.ts` (`seedAdmin`, `adminSignIn`, `signUpViaOtp`, `nextMobile`). Copy the structure of `demand.int-spec.ts`.
- **Always cover:**
  - happy path
  - 403 for the wrong role
  - 404 for another tenant
  - invalid state transition (409/422)
  - idempotent replay where relevant
  - the concurrency case where relevant (`Promise.all`)

### 4. Docs (same change)
- `docs/API.md`: endpoints, permissions and error codes.
- `docs/DATABASE.md`: collection and indexes.
- `docs/DEVELOPMENT_PLAN.md`: progress row and delivery notes.
- `docs/SRS.md` §19.3: acceptance criteria status, if it changed.

Use the `phase-docs-update` skill for the doc pass.

### 5. Verify
Run the `quality-gates` skill. For UI-facing features, also use `run-app` and exercise the endpoint through the web proxy.
