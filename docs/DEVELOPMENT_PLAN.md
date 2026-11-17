# SkillConnect — Development Plan

| Field | Value |
|---|---|
| Version | 1.0 (Approved 2026-11-13) |
| Source | docs/SRS.md v1.0, docs/ARCHITECTURE.md v0.1 |


## Context
`D:\SkillConnect` is a new project with no git repository. It contains:
- `docs/SRS.md` v1.0: the requirements, with the Section 13 defaults accepted.
- `docs/ARCHITECTURE.md` v0.1: the proposed architecture. It covers the modular monolith (api and worker processes), the module map, the core infrastructure, the allocation concurrency design (§6.3), the payment flows (§6.5), the outbox, RBAC, the frontend structure, and the technical decisions T-01 to T-16.

The user wants a detailed implementation plan for building the platform described in the SRS. This plan sequences the work one module at a time, as the brief requires. Each module ships with: schemas and indexes, DTOs, services, controllers, authorisation, frontend screens, API integration, unit and integration tests, Swagger, and documentation.

There is no existing code to reuse. Everything below is new, and every module uses the shared core components defined in Phase 1.

---

## Progress

| Phase | Status | Notes |
|---|---|---|
| 0 Design docs | ✅ Done (2026-11-13) | SRS, ARCHITECTURE, DATABASE, API, DEVELOPMENT_PLAN, TEST_PLAN |
| 1 Foundation | ✅ Done (2026-11-13) | See "Phase 1 delivery notes" below |
| 2 Identity, access, platform | ✅ Done (2026-11-13) | See "Phase 2 delivery notes" below |
| 3 Catalogue & provider onboarding | ✅ Done (2026-11-13) | See "Phase 3 delivery notes" below |
| 4 Demand side | ✅ Done (2026-11-13) | See "Phase 4 delivery notes" below |
| 5 Allocation core | ⏭ Next | Assignments & commitments, Matching, Invitations, Allocation Proposals |

### Phase 1 delivery notes
- **Delivered:** pnpm monorepo; strict TypeScript; ESLint 9 flat config (with a module-boundary rule), Prettier;
  `packages/contracts`; all `apps/api/src/core/*` components listed in §1.3; api and worker entry points;
  Swagger at `/api/docs`; web foundation (router with lazy route groups and portal guards, API client with
  single-flight refresh, design tokens, shared UI and form components, DataTable, FileUpload); Docker Compose
  for dev dependencies; API and web Dockerfiles; GitHub Actions CI.
- **Tests:** 34 contracts, 77 API (unit + integration against an in-memory MongoDB replica set), 28 web.
- **Deviations from the plan, and why:**
  - *Index creation* uses `db:sync-indexes` (indexes declared once on the Mongoose schemas) instead of
    `migrate-mongo` index migrations, which would duplicate every index definition. `migrate-mongo` will be
    added for data/seed migrations when Phase 2 needs them.
  - *Zod bridge* is a small in-house `createZodDto` + `ZodValidationPipe` + Swagger helpers instead of the
    `nestjs-zod` package (fewer moving parts, same outcome as decision D-01).
  - *Rate limiting* is an in-house Redis fixed-window guard instead of `@nestjs/throttler`; it fails open if
    Redis is down so the API degrades instead of hanging.
  - *`exactOptionalPropertyTypes`* is not enabled: it conflicts with Mongoose and Nest typings. All other
    strict flags (including `noUncheckedIndexedAccess`) are on.
  - *Module boundaries* are enforced with ESLint `no-restricted-imports` patterns rather than
    `eslint-plugin-boundaries`; this is revisited when the first business modules land in Phase 2.
  - Pinned to proven major versions (NestJS 11, Zod 3, Mongoose 8, React 18, Vite 6, Tailwind 3) rather than
    the newest majors.
- **Not verified locally:** Docker is not installed on the development machine, so the compose file and
  Dockerfiles have not been run here; CI builds the images.

### Phase 4 delivery notes
- **Delivered (API):**
  - Companies (FR-CMP-01..04):
    - Self-registration by a company account. The creator becomes Company Admin and primary contact in one transaction.
    - The PAN is stored encrypted, with a hash for uniqueness. The GSTIN must match the billing state and the PAN.
    - States `PENDING_VERIFICATION → ACTIVE ⇄ SUSPENDED`. Enquiries are allowed while pending; jobs and quotation acceptance are not.
    - Sites with a GeoJSON location (2dsphere index), timezone, contact and optional geofence. Sites are deactivated, never deleted.
    - Team invites by mobile with the Company Admin or Company User role, optionally limited to sites. Invited people sign in with the normal OTP flow and land in the account created for them. Site limits are enforced in every company list and lookup.
    - Admin: list, detail, activate or reinstate, suspend with a reason, commercial terms, blocked providers, add sites, team view.
  - Enquiries (FR-ENQ-01..04):
    - Intake from companies, from admins on a company's behalf, and from public leads. Public intake is rate limited to 5 per hour per IP, has a honeypot field and accepts a `captchaToken`.
    - Numbering `ENQ-000001`. Assigning an enquiry moves it from `NEW` to `IN_REVIEW`. Internal notes, manual decline and cancel.
    - Lead conversion to a new company (the lead contact becomes Company Admin) or to an existing one, with an optional first site.
  - Quotations (FR-QUO-01..06):
    - A shared GST engine in `packages/contracts/src/tax.ts`, also used by the web builder:
      - line amount = rate × headcount × quantity
      - the discount is spread over lines by largest remainder, and GST is charged on the discounted value
      - CGST + SGST at half the rate each for intra-state supply, IGST for inter-state, rounded half-up per line
      - place of supply = the company's billing state; supplier details come from the `tax.supplier` setting
    - SAC and GST rate default from the skill and the `tax.*` settings.
    - Versioning: `revise` creates version n+1 as a DRAFT and marks a SENT version SUPERSEDED. A partial unique index guarantees one current version per enquiry.
    - Sending notifies the Company Admins. The PDF is rendered in the background (`quotation.sent` outbox event) and on demand, stored privately under `exports/` and served through a short-lived signed URL.
    - Accepting (🔁 Idempotency-Key) records the user, time, IP and user agent, and creates the job **in the same transaction**. A unique index on `jobs.quotationId` backs this up; concurrent accepts create one job.
    - Rejection with a reason. An hourly job moves overdue SENT quotations, and their enquiries, to EXPIRED.
  - Jobs (FR-JOB-01..06):
    - Created OPEN from an accepted quotation (positions from the lines, minimum experience from the enquiry), or manually as a DRAFT for an ACTIVE company.
    - The state machine lives in contracts (`JOB_TRANSITIONS`). Resuming returns a job to the status it was held from. Completion is allowed only after the end date.
    - Edits (`If-Match`) never drop `required` below held + confirmed, and never remove or re-skill a position with allocations. The update is guarded on unchanged held and confirmed counts, so it cannot race Phase 5 reservations. Schedule, shift and headcount changes return `impact[]`.
    - Outbox events `job.created`, `job.updated`, `job.put_on_hold`, `job.cancelled` and `job.status_changed` for the Phase 5 cascades, plus company notifications.
  - A `@PlatformOnly()` guard: `/admin/*` routes behind permissions that portal roles also hold (`job.read`, …) refuse portal users.
  - A small dependency-free PDF writer (`core/pdf/simple-pdf.ts`) for quotations, reusable for invoices.
  - Notification templates for company, enquiry, quotation and job events. New business settings: `tax.supplier`, `tax.defaultGstRateBp`, `tax.defaultSacCode`, `quotation.defaultValidityDays`, `quotation.prefix`, `enquiry.prefix`, `job.prefix`.
- **Delivered (web):**
  - Company portal: registration; dashboard with a verification banner; sites (address with GST state, "use my location"); team with site limits; enquiries (list, create, detail, cancel); quotations (list, detail with the GST breakdown, PDF, accept or reject with one idempotency key per decision); jobs (list, detail with staffing).
  - Admin: companies (list, KYC detail, activate or suspend, commercial terms, sites, team); enquiry inbox (filters, assign to me, notes, decline or cancel, lead conversion); quotation builder (lines, schedule, milestones, live CGST/SGST or IGST totals, PDF preview, send, revise); jobs (list, manual creation, a workspace with tabs, hold, resume, cancel, complete, and a headcount and end-date edit that shows the impact).
  - A public "Request a quote" page, linked from the header and the home page.
- **Tests:** see the gate results in the Phase 4 report. New suites: `packages/contracts/src/demand.spec.ts`, `apps/api/src/modules/phase4-units.spec.ts`, `apps/api/test/modules/demand.int-spec.ts` (10 scenarios, including 5 concurrent accepts → 1 job), `apps/web/src/routes/company/demand.test.tsx`.
- **Deviations / deferred:**
  - *Quotation PDF* is stored as `quotations.pdf {key, rev}` rather than as a `documents` record (`pdfDocId`), and is regenerated whenever a draft changes. Email and WhatsApp delivery of the PDF waits for real channel templates; in-app and SMS notifications are sent.
  - *Withdraw* of a sent quotation is not offered: revising supersedes it.
  - *Enquiry attachments* and *blocked-provider editing in the UI* (the API exists) are deferred.
  - *Captcha verification* is not enforced yet (the token is accepted); the rate limit and honeypot are active.
  - *Map picker*: sites use latitude/longitude with "use my location", as for providers.

### Phase 3 delivery notes
- **Delivered (API):**
  - Service catalogue: category tree up to 3 levels, skills, public catalogue endpoints, and a starter catalogue on first run.
  - Documents:
    - Signed uploads to private storage, a check of the real file type from its first bytes, and a virus scan.
    - Versions, where a new upload supersedes the old one.
    - Download links that only the owner and reviewers can get, with each download of a sensitive document audited.
    - Review by a verification officer, and an expiry job.
    - Each owning module registers its own access check, so Documents never depends on provider modules.
  - Registration plans, with three starter plans.
  - The person registry: one active provider identity per person, matched on ID number or mobile, with an admin queue for conflicts.
  - Professionals: profile, skills, availability and bank details, with rules on which states allow edits.
  - Vendors: the creator automatically becomes the vendor's admin, and more admins can be added.
  - Vendor workers:
    - The plan's worker limit holds even when workers are added at the same moment.
    - Each worker claims a unique identity.
    - Workers are verified, and can be deactivated.
  - Registrations:
    - Plan choice and a readiness checklist.
    - Submission: professionals claim their identity at this point.
    - Online payment through Razorpay, where the webhook is the source of truth, plus offline payments verified by a second person.
    - Fee waivers, and approve, reject or request-changes decisions.
    - Refunds on rejection according to the plan: approved by a second person, capped at the amount received, and posted to the ledger.
  - Payments core:
    - The webhook endpoint stores each event once and hands it to background processing through the outbox.
    - An append-only double-entry ledger with its own registration book.
    - Razorpay over its REST API, or a fake gateway with a simulator endpoint for development.
  - Notification templates for registration events.
  - `BackgroundModule` and `CliModule`.
- **Delivered (web):**
  - Provider registration page for both professionals and vendors: profile, skills, plan cards, online or offline payment, document checklist with uploads, submission and status messages.
  - Vendor workers page, provider home, and a public category page.
  - Admin screens: the verification queue (registrations, workers and identity conflicts), the registration review page (profile, documents with open, verify and reject, fee, waiver, decisions), catalogue and plans, and finance (offline verification, payment history and refunds).
- **Tests:** 34 for contracts, 171 for the API (including 11 Phase 3 integration tests: the full professional journey, webhook signature and duplicate handling, out-of-order failure events, offline payments verified by a second person and duplicate references, refunds, the worker limit under concurrent adds, identity conflicts, and upload security), and 36 for the web app. The live app was also driven end to end through the web server's API proxy.
- **Fixed during the phase:**
  - Registration upsert conflict: `providerName` was set in both `$set` and `$setOnInsert`.
  - The command-line tools hung: they started background processing and never exited because the Redis client kept retrying. They now use their own `CliModule` and exit explicitly.
- **Development fallbacks (all refused when `NODE_ENV=production`):**
  - `QUEUE_MODE=inline`: jobs and events run in-process inside the API, with the same retry and de-duplication behaviour.
  - `STORAGE_DRIVER=local`: files are stored on disk behind HMAC-signed URLs.
  - `SCANNER=none`: file-type checks only, plus detection of the EICAR test file.
  - A fake Razorpay gateway is used when no Razorpay keys are configured.
- **Deviations / deferred:**
  - *Document scanning* runs when the upload is completed (one request) rather than as a queued job. This is fine for files of 20 MB or less, and the queue name `DOCUMENT_SCAN` is reserved if scanning needs to move to the worker.
  - *Vendor plan upgrades*: paying the difference to move to a larger plan is deferred. Plans can still be changed before payment.
  - *Logins for vendor workers* (decision T-10) and the check that blocks deactivating a worker with future assignments (FR-VWK-06) come with Assignments in Phase 5.
  - *Document expiry reminders*: the expiry job marks documents expired, but the reminder notifications sent before expiry are not yet sent.
  - *Map picker*: locations are entered as latitude/longitude, with a "use my location" button. A map widget can come later.

### Phase 2 delivery notes
- **Delivered (API):**
  - Users & RBAC: users, roles, role assignments with a scope, seeding of the system roles, admin user management with invitation emails, and protection of the last Super Admin.
  - Auth:
    - Mobile OTP sign-in, with sign-up on first use.
    - Admin email + password + TOTP. Authenticator setup is enforced, and each code works only once.
    - Password login for company users, plus password reset and change.
    - Rotating refresh cookies with reuse detection, logout, force logout, and account lockout.
  - A permission resolver whose role lookups are cached in Redis.
  - Audit-log search and the settings API.
  - Notifications:
    - Transactional `notification.requested` events and an in-app inbox.
    - Channel fallback, preferences and mutes, and quiet hours.
    - Templates with preview, and a delivery-receipt webhook.
  - The `cli:create-admin` command for creating the first admin.
- **Delivered (web):**
  - OTP sign-in and sign-up, admin sign-in with authenticator setup by QR code, and forgot/reset password.
  - Admin screens: Users (list, create, and a detail page with roles and account actions), the Roles editor, the Audit log explorer, the Settings editor and the Message templates editor.
  - A notification bell and a notifications page with preferences.
  - Navigation filtered by permission.
- **Tests:** 34 for contracts, 145 for the API (including the RFC 6238 TOTP test vectors and 22 auth, 9 RBAC and 10 platform/notification integration tests), and 32 for the web app.
- **Fixed during the phase:**
  - Error responses from the input sanitiser now carry `requestId`.
  - The permission resolver now re-checks the user's status and `permVersion` on every request. Before, a cache hit could keep a suspended user's token working for up to 10 minutes.
  - The unique index on active role assignments used a `$exists: false` filter, which MongoDB does not support in partial indexes. It now filters on an `active` flag.
  - The Redis client now fails fast when disconnected. Before, every request took several seconds while Redis was down.
- **Deviations:**
  - *Password hashing* uses scrypt (N=2^15, r=8, p=1) from Node's standard library instead of Argon2id or bcrypt (SRS §10.3). This avoids a native build dependency, and scrypt is a memory-hard KDF that OWASP recommends. The parameters are stored with each hash, so they can be raised later.
  - *TOTP* is implemented in-house (RFC 6238) and checked against the RFC test vectors, rather than taken from a library.
  - *Admin MFA setup* happens during sign-in using the short-lived MFA step token (API.md §4.1), not after a session is issued. An admin therefore never holds a session without MFA.
  - *Vendor and company users* get no role at sign-up. Their admin role, scoped to their organisation, is granted when the organisation is created (Phases 3–4).

## Phase 0 — Finish design docs (approval gate)
Write the remaining design documents, then stop for approval before writing code.
- `docs/DATABASE.md`: every collection, with its fields, enums, embedded or referenced choice, and indexes (unique, partial, TTL, 2dsphere, compound). It also gives the transaction boundaries per use case and the money and date conventions: integer paise, `YYYY-MM-DD` site-local dates, minutes from midnight for shifts.
- `docs/API.md`: conventions (envelope, errors, pagination, `Idempotency-Key`), the error-code catalogue and the permission catalogue. Then every endpoint, grouped by module, with method, path, permission, scope, request and response schema names, and status codes. Full examples for: OTP login, invitation response, proposal submit and approve, online and offline payment, refund, and the Razorpay webhook.
- `docs/DEVELOPMENT_PLAN.md`: this plan, in repo form.
- `docs/TEST_PLAN.md`: the strategy and tools, the critical scenario catalogue (concurrency, idempotency, webhooks, state machines, RBAC and IDOR, upload security) and a traceability matrix from FR to test.

---

## Phase 1 — Foundation (no business features)

### 1.1 Workspace and tooling
- Set up a pnpm workspace: `apps/api`, `apps/web`, `packages/contracts`, `packages/tsconfig`.
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). ESLint with `@typescript-eslint/strict`, `eslint-plugin-boundaries` for module boundaries (ARCHITECTURE §1), Prettier, Husky and lint-staged, and commitlint.
- Run `git init`. Branching: `main` plus feature branches.
- `infra/compose/docker-compose.dev.yml` runs: mongo (single-node replica set `rs0` with an init script), redis, minio (with the bucket created), clamav and mailpit.
- Multi-stage Dockerfiles for `api`, `worker` and `web`, running as a non-root user.
- CI in GitHub Actions: install, lint, typecheck, unit tests, integration tests (compose services), build and Docker build.

### 1.2 `packages/contracts`
- `error-codes.ts`, `permissions.ts`, `roles.seed.ts`, `business-config.ts` (Zod registry plus defaults), `enums/` (all statuses), `common.ts` (pagination, money, `ObjectId` string, envelope), and one folder per module for the Zod schemas as they are built.

### 1.3 Backend core: `apps/api/src/core/*`
These are the components described in ARCHITECTURE §5. Build them in this order:
1. `config`: Zod environment schema, fail fast at boot.
2. `logging`: nestjs-pino with redaction and a request ID.
3. `http`: `ResponseEnvelopeInterceptor`, `AllExceptionsFilter`, `RequestIdMiddleware`, Helmet, CORS, `ZodValidationPipe` (global), key sanitiser, Redis throttler.
4. `errors`: `DomainError` and the mapping from errors to HTTP statuses.
5. `database`: Mongoose connection and `TransactionRunner.withTransaction(fn)`, with retries for transient errors and unknown commit results.
6. `redis` and `queue`: BullMQ registry, default options, dead-letter queue.
7. `outbox`: `OutboxService.add(evt, session)` and `OutboxRelay` (a lease-claim poller in the worker).
8. `idempotency`: `@Idempotent()` interceptor and the `idempotency_keys` collection (TTL 24 hours).
9. `audit`: `AuditService.record` and the `audit_logs` collection. This module is append-only; its repository has no update or delete.
10. `crypto`: AES-256-GCM field encryption with versioned keys, and HMAC hashing.
11. `sequence`: `counters` collection with `next(name, session)`.
12. `business-config`: `BusinessConfigService.get/set`, a Redis cache, pub/sub invalidation and `business_settings` versions.
13. `storage`: S3 presigned PUT and GET, head, copy and delete.
14. `scanning`: clamd client.
15. `channels`: `SmsProvider`, `WhatsAppProvider`, `EmailProvider` interfaces, plus console or Mailpit adapters for development.
16. `health`: terminus checks, `/health/live` and `/health/ready`.
17. `auth` guards (skeleton): `JwtAuthGuard`, `PermissionsGuard`, `ScopeGuard`, `@CurrentUser`, `@RequirePermissions`, `@Public`.
- Swagger at `/api/docs`, generated from nestjs-zod, with a bearer auth scheme.
- `migrate-mongo`: migration framework and the first migration (indexes for core collections).
- `worker.ts` bootstrap with health checks only, no HTTP API.

### 1.4 Web foundation: `apps/web`
- Vite, React, TypeScript strict, Tailwind with design tokens (ARCHITECTURE §8.3), and shadcn/ui initialised.
- `lib/apiClient.ts`: axios with envelope unwrapping, a `ApiError` type carrying `code` and `details`, and a single-flight refresh on 401. Also `lib/queryKeys.ts`, `lib/format.ts` (INR from paise, IST dates) and `lib/permissions.ts` (`useCan`).
- `app/router.tsx` with the lazy route groups `public`, `company`, `provider` and `admin`. Route guards check authentication and permissions.
- Layouts: `PublicLayout`, `AppShell` (sidebar, topbar, notification bell placeholder) and `ProviderMobileLayout` (bottom navigation).
- Reusable components: `DataTable` (server pagination, URL-synced filters), `PageHeader`, `StatusBadge` (enum to colour map), `EmptyState`, `ConfirmDialog`, `FormField`, `MoneyInput`, `PhoneInput`, `OtpInput`, `DateRangePicker`, `FileUpload` (presigned three-step flow) and `ServiceCategoryCard`.
- Testing setup: Vitest and React Testing Library, MSW for API mocks, Playwright scaffold.

**Exit criteria:**
- `docker compose up` brings up the dependencies.
- `pnpm dev` runs the api, worker and web.
- `/health/ready` reports green, and Swagger loads.
- CI passes.
- Unit tests cover the envelope, exception filter, idempotency, outbox relay, transaction runner retry and crypto.

---

## Per-module Definition of Done (applies to every module below)
1. Zod contracts in `packages/contracts/<module>`.
2. Mongoose schema(s) and indexes, plus a migration that creates the indexes.
3. A pure `domain/` layer: state machine and policies, at least 90% unit test coverage.
4. A repository that is session-aware and always applies a scope filter.
5. An application service, with transactions where the operation is multi-document or financial, audit records and outbox events.
6. A controller with `@RequirePermissions`, scope guard, `@Idempotent` where required, and Swagger decorators.
7. Frontend: feature hooks in `features/<module>/api.ts`, plus screens and forms using the contract schemas.
8. Tests: unit tests for domain and service logic (mocked repositories), integration tests (supertest against a real replica set, covering auth, RBAC denial, validation and state transitions), and component tests for complex forms.
9. Updates to `API.md`, `DATABASE.md` and the module README section.
10. A demo script or seed data for the module.

---

## Phase 2 — Identity, access and platform services

| Module | Backend scope | Frontend scope |
|---|---|---|
| **Users & RBAC** | `users`, `roles`, `role_assignments` (scoped). Seed system roles and permissions. A permission resolver with a Redis cache keyed by `permVersion`. Admin CRUD for users and roles, suspending and deactivating users. | Admin: users list, user detail, roles editor (permission checklist). |
| **Auth** | `otp_challenges` (hashed OTP, attempts, TTL index), `refresh_tokens` (hashed, family, TTL). Endpoints: OTP request and verify (providers and companies), admin password login and TOTP enrolment and verification, refresh (rotation and reuse detection), logout, force logout, password reset. Lockout and rate limits. | Login (OTP and admin password + TOTP), MFA enrolment (QR), password reset, auth context and bootstrap refresh. |
| **Audit Logs** | Search API (entity, actor, action, date) with cursor pagination. | Admin: audit log explorer with a diff viewer. |
| **Business Config** | `GET/PUT /admin/config/:key`, validated against the contract registry, versioned and audited. | Admin: settings page grouped by domain, with forms generated from the schemas. |
| **Notifications (core)** | `notification_templates`, `notifications` (in-app and delivery log), `notification_preferences`. An event-to-template router, a channel fallback chain, BullMQ senders with retry, delivery webhooks (WhatsApp and SMS status), quiet hours. Template CRUD. In-app inbox API. | Notification bell and inbox, preferences page, admin template editor with variable preview. |

**Exit criteria:** OTP login works end to end with the dev SMS adapter. Admin login with TOTP works. An RBAC denial returns 403. Changing a config value invalidates the cache.

---

## Phase 3 — Catalogue and provider onboarding

| Order | Module | Key backend items | Frontend |
|---|---|---|---|
| 3.1 | **Service Categories** | `service_categories` (tree up to 3 levels, slug unique, `ancestors[]`), `skills` (categories, required doc types). Public read endpoints with a cache. A category in use is deactivated rather than deleted. | Public home with a hero search and a category grid of large image cards. Category detail page. Admin category tree and skills CRUD with image upload. |
| 3.2 | **Documents** | `document_types` (configurable rules), `documents` (versions, status, expiry, encrypted number and its hash). The ARCHITECTURE §6.7 flow: upload intent, presigned PUT to quarantine, complete, scan worker (`file-type` magic bytes plus clamd), move to the clean area. Download URL with authorisation. Expiry reminder and expiry scheduled jobs. | `FileUpload` wired to the real API. Document checklist component (reused for professionals, vendors, workers and companies). Admin document types. |
| 3.3 | **Registration Plans** | `registration_plans` (provider type, fee in paise, GST, maximum workers, mandatory docs, offline allowed, refund policy, effective dates). Admin CRUD. Public active plans by type. | Admin plans CRUD. Plan selector cards in onboarding. |
| 3.4 | **Person Registry** | `persons` (`idHash` and `mobileHash` with partial unique indexes on active persons, `activeRole`, `scheduleVersion`). `claim(personInput, roleRef, session)` and `release`. A conflict raises `PERSON_ALREADY_ACTIVE`, which goes into an admin resolution queue. | Admin: identity conflict queue. |
| 3.5 | **Professionals** | `professionals` (profile, a GeoJSON `serviceLocation` with a 2dsphere index, `radiusKm`, skills with proficiency, availability rules and blocked dates, lifecycle, denormalised `eligibility` flags, encrypted bank details). Completion percentage calculator. Lifecycle state machine (FR-PRO-04). Re-verification on edits to verified fields (FR-PRO-06). | A **mobile-first onboarding wizard**: type, profile, skills, location (map pin with radius), documents, plan, pay, submit. Availability calendar editor. Profile page. |
| 3.6 | **Vendors** | `vendors` (legal details, GSTIN and PAN, operating locations array with a 2dsphere index, contacts, lifecycle). Vendor Admin user management (scoped role assignments). | Vendor onboarding wizard and vendor profile. Vendor users. |
| 3.7 | **Vendor Workers** | `vendor_workers` (`personId`, skills, base location, status, availability). Worker-cap enforcement uses the registration plan snapshot, with a conditional `$inc` on `vendor.activeWorkerCount`. Deactivation is blocked while future assignments exist. Optional worker user account with OTP login (T-10). | Vendor: workers list and detail, add or edit worker, bulk CSV import (phase 2 option). Worker documents. |
| 3.8 | **Payment Gateway and Ledger (core/finance)** | Razorpay adapter (orders, payments fetch, refunds, settlements) with an injectable test fake. `POST /webhooks/razorpay`: verify the raw-body HMAC, insert into `webhook_events` (unique on `eventId`), return 200, enqueue. Worker router by `notes.domain`. `ledger_entries` (`book`, accounts, debit and credit, balanced per `journalId`, append-only). | — |
| 3.9 | **Registration Payments** | `provider_registrations` (plan snapshot, status, verification checklist and decisions), `registration_payments`, `registration_refunds`. Online flow per ARCHITECTURE §6.5 with `Idempotency-Key`. Offline record and maker-checker verify. Waiver (`registration.waive`). Upgrade by paying the difference. Verification endpoints: queue, checklist, approve, reject, request changes. On approval: provider `APPROVED` plus an outbox event. Refund on rejection per the plan's policy. Stuck-payment sweeper. | Provider payment step (Razorpay Checkout script, processing state, polling status). Admin **verification queue** (filters, side-by-side document viewer, per-item checklist and comments). Admin registration payments list, offline verification, refunds. |

**Exit criteria:** a professional and a vendor can each complete onboarding, pay in Razorpay test mode or record an offline payment that is then verified, and be approved by a verification officer. A duplicate webhook is ignored. A duplicate identity is blocked.

---

## Phase 4 — Demand side

| Order | Module | Key backend items | Frontend |
|---|---|---|---|
| 4.1 | **Companies** | `companies` (KYC fields, state, commercial terms, blocked providers list), `company_sites` (GeoJSON, contact, timezone). Company signup through OTP. Admin activation. Company user invitations with site-scoped roles. | Company signup and profile, sites management (map picker), users. Admin companies list and detail with KYC activation. |
| 4.2 | **Enquiries** | `enquiries` (lines of skill and headcount, site, schedule, shift, attachments, state, assignee, internal notes). Public lead intake (rate-limited, captcha-ready). Conversion of a lead to a company. | Public enquiry form. Company enquiries list and create. Admin enquiry inbox (assign, notes, status). |
| 4.3 | **Quotations** | `quotations` (versioned with `quotationNo` plus `version`, line items, discounts, terms, payment milestones, validity). Tax engine in `core/finance/tax` (SAC rules, intra-state vs. inter-state CGST, SGST and IGST, half-up rounding per line). PDF through a worker (T-12). Send through outbox and notifications. Accept and reject with IP and user captured. **Accepting creates the job in the same transaction**, through `JobsService.createFromQuotation(session)`. Validity expiry scheduled job. | Admin quotation builder (line editor, live tax totals, preview PDF). Company quotation view and accept or reject. |
| 4.4 | **Jobs** | `jobs` (number from `sequence`, company, site, positions embedded with `required/held/confirmed/available`, `billRate`, `payRate`, shift minutes, schedule date range plus weekdays plus exclusions, state machine per FR-JOB-03, `version`). Manual creation by an admin. Hold, resume and cancel (cascading through outbox events to invitations, proposals and assignments). Editing headcount and schedule triggers re-validation (FR-JOB-05). | Admin jobs list and **job detail workspace** (tabs: Overview, Matching, Invitations, Proposals, Assignments, Attendance, Invoices). Company jobs list and detail. |

---

## Phase 5 — Allocation core (highest risk, most tests)

| Order | Module | Key backend items | Frontend |
|---|---|---|---|
| 5.1 | **Assignments (commitments first)** | `commitments` (`personId`, `proposalId`, `assignmentId?`, status `HELD/CONFIRMED/RELEASED`, date range, weekdays, shift minutes; index `{personId, status, startDate, endDate}`). A pure `overlaps(a, b)` function that handles crossing midnight, weekdays and excluded dates. `CommitmentService.hold/confirm/release(session)`, each of which first writes `persons.scheduleVersion` (ARCHITECTURE §6.3). `assignments` (partial unique index `{jobId, personId}` where the assignment is active). States per FR-ASG-02. `assignment_change_requests` for provider cancellation requests. The ability to create assignments is exported **only** to Allocation Proposals. | Provider: my assignments (mobile cards with site address revealed). Company: assigned staff per job. Admin: assignments tab, cancellation requests queue. |
| 5.2 | **Matching** | Aggregation per position: `$geoNear` then status, skill and eligibility `$match`, then a batched commitment and availability filter in the application, then a pure `score()` with config weights. Vendors are grouped by eligible workers. `match_runs` snapshot (inputs, weights version, candidates with breakdown, exclusions with reasons, overrides with justification). Overrides allowed per FR-MAT-05; availability conflicts are never overridable. | Admin matching tab: run matching per position, ranked table with score breakdown popover, filters, manual add with justification, select candidates and invite. |
| 5.3 | **Invitations** | `invitations` (unique active per `{positionId, providerRef}`, deadline, status, `responses[]` with versions, `lockedByProposal`, `offeredHeadcount`, `reservedCount`, `confirmedCount`, proposed workers, availability snapshot). Bulk send (outbox, WhatsApp deep link with a signed short token). Mark viewed. `PUT /invitations/:id/response` with `@Idempotent`, version append and conditional update (ARCHITECTURE §6.4). Vendor validation of named workers. Withdraw. Expiry scheduled job. **There is no import path to assignment creation.** | Provider (mobile-first): invitation inbox, invitation detail, respond (availability confirmation; vendors choose a headcount and optionally pick workers). Admin invitations tab with response status and response history. |
| 5.4 | **Allocation Proposals** | `allocation_proposals` (lines: position, person, invitation reference, and worker for vendor lines; status; `version`; validation results; `createdBy`, `approvedBy`; reason). A pure `capacity-validator` returning blocking errors and warnings for FR-ALC-04 (a) to (f). **Submit transaction**: reserve position places, vendor places and `HELD` commitments. **Approve transaction**: the 9 steps in ARCHITECTURE §6.3, with `@Idempotent` and separation of duties (BR-ALC-07). Reject or cancel releases the holds. Clone a rejected proposal. A replacement proposal type (FR-ASG-04) marks the old assignment `REPLACED` and releases it in the same transaction. Outbox `allocation.approved` and `assignment.confirmed` events go to the notification fan-out (provider, worker and company). | Admin: proposal builder (choose from interested responses, live validation panel with errors and warnings, acknowledge warnings), proposals list, **approval screen** (diff of lines, validation recheck, approve or reject with reason). The 409 conflict UX offers a refresh and shows what changed. |

**Exit criteria:** the full 11-stage flow (SRS §6.1) runs end to end in the UI. The concurrency test suite passes (see Verification).

---

## Phase 6 — Execution

| Module | Backend | Frontend |
|---|---|---|
| **Attendance** | `attendance_records` (assignment, date, check-in and check-out time, GPS, geofence distance and flag, selfie document reference, proxy flag, company confirmation and dispute, corrections history). Check-in sets the assignment to `ACTIVE`. No-show scheduled job (grace period from config). A dispute raises a complaint event. Summary aggregation used for invoicing. | Provider mobile check-in and check-out (geolocation, camera capture). Vendor proxy attendance. Company daily confirmation grid. Admin corrections. |
| **Complaints** | `complaints` (link reference, category, severity, SLA due date, state, comment thread with an internal flag, escalation level). SLA breach scheduled job with escalation. Resolution outcome feeds performance. | Raise complaint (all portals), complaint thread, admin complaints queue with SLA countdown. |
| **Ratings & Performance** | `ratings` (one per assignment, unique), `performance_snapshots`. Nightly recompute with config weights. Writes the denormalised `performanceScore` onto professionals and workers for matching. | Company rating prompt on completion. Provider performance card. |

---

## Phase 7 — Finance

| Order | Module | Backend | Frontend |
|---|---|---|---|
| 7.1 | **Invoices** | `invoices` (number from a gap-free `sequence` per financial year, allocated inside the issue transaction; lines; tax split; place of supply; `totalPaise`, `paidPaise`, `balancePaise`; due date; states per FR-INVC-04), `credit_notes` (separate series). Generation from milestones or from the attendance summary for a period. Issuing is immutable and posts to the ledger (receivable). PDF. Overdue scheduled job. | Admin invoice generator and list. Invoice detail with PDF. Company invoices list and detail. |
| 7.2 | **Business Payments** | `business_payments` (online or offline, method, reference, unique partial index on `{method, reference, bank}` for offline, status, `capturedPaise`, `refundedPaise`, `recordedBy`, `verifiedBy`, cheque sub-states), `payment_allocations`. Online flow per §6.5 (amount computed on the server from the invoices). Offline record by the company or finance. Verify with maker-checker. Cheque lifecycle. Webhook handler for the BUSINESS domain. Allocation and invoice balance updates with conditional `$inc`. Ledger postings. **Refunds**: `business_refunds`, threshold approval, Razorpay refund from the worker, webhook outcome, guard `refunded <= captured`. | Company: pay invoices (select invoices, Razorpay checkout), record offline payment with a proof upload, payment history. Admin finance: payments list, offline verification queue (maker-checker), cheque status actions, refunds (initiate and approve). |
| 7.3 | **Payment Reconciliation** | `reconciliation_runs`, `reconciliation_items`, `bank_statement_lines`. Daily gateway reconciliation job (Razorpay payments and settlements against local records, separate books). Bank statement upload (CSV or XLSX through presigned upload, configurable column mapping, parsing in the worker). Auto-match by reference, amount and date tolerance. Manual match. Exception resolution. Receivables ageing and unapplied payments. | Admin: reconciliation runs, run detail (matched, unmatched and exceptions tabs), manual matching UI, statement upload with a column-mapping wizard. |

**Exit criteria:** an invoice can be paid online, with a duplicate webhook doing nothing. An offline payment verified by a second user updates the balance. A partial refund is capped. The reconciliation run flags a planted mismatch.

---

## Phase 8 — Reports, polish, hardening and release
- **Reports**: query services per module (read-only). Aggregations for FR-RPT-01 to FR-RPT-08 with a common filter DTO. `report_exports` runs CSV and XLSX generation asynchronously (exceljs) and delivers a presigned download link. Admin reports hub, charts, and a dashboard KPI tiles for each portal.
- **Public site polish**: SEO meta, image optimisation, responsive QA from 360 px.
- **DPDP**: consent records, data export and anonymisation endpoints.
- **Hardening**:
  - Security review (OWASP ASVS L2 checklist; IDOR tests per scoped endpoint; dependency audit).
  - k6 load tests against the NFR-PERF targets.
  - Accessibility audit with axe in Playwright.
  - Backup and restore drill.
  - Log redaction check.
- **Release**: staging deployment, seed data, UAT scripts per role, production runbook (secrets, Razorpay live keys, WhatsApp templates approved, DLT templates registered, index migrations).

---

## Critical files (representative)
- `apps/api/src/core/database/transaction-runner.ts`: the retrying transaction wrapper used by all financial and allocation flows.
- `apps/api/src/core/outbox/{outbox.service,outbox.relay}.ts`
- `apps/api/src/core/idempotency/idempotency.interceptor.ts`
- `apps/api/src/core/finance/{payment-gateway,ledger,tax}/`
- `apps/api/src/modules/assignments/domain/overlap.ts` and `commitment.service.ts`
- `apps/api/src/modules/allocation-proposals/domain/capacity-validator.ts` and `allocation-proposals.service.ts` (submit and approve transactions)
- `apps/api/src/modules/invitations/invitations.service.ts` (idempotent response)
- `apps/api/src/modules/matching/domain/score.ts` and `matching.repository.ts` (`$geoNear` pipeline)
- `apps/web/src/lib/apiClient.ts`, `apps/web/src/components/data-table/DataTable.tsx`, `apps/web/src/components/forms/FileUpload.tsx`
- `packages/contracts/src/{permissions,error-codes,business-config}.ts`

---

## Verification
- **Unit tests** (Jest on the API, Vitest on the web): state machines (every allowed and forbidden transition), `overlaps()` edge cases (crossing midnight, weekdays, exclusions), `score()`, `capacity-validator`, tax rounding, and invoice numbering format.
- **Integration tests** (Jest and supertest against a real MongoDB replica set and Redis from compose or Testcontainers, with Razorpay, SMS and WhatsApp faked at the adapter):
  - RBAC: every endpoint returns 403 for a wrong role and 404 or 403 for another tenant's resource.
  - **Concurrency**: approve two proposals at once that compete for the same person or the last remaining place, using `Promise.all` × 20 runs. Exactly one succeeds, the other gets 409, and the counters are consistent.
  - Approving the same proposal twice with the same `Idempotency-Key` returns the same response and creates a single set of assignments.
  - Invitation response replay is idempotent, and a response never creates an assignment (assert the `assignments` count stays 0).
  - Webhooks: an invalid signature returns 401. A duplicate `eventId` is processed once. `failed` arriving after `captured` causes no downgrade. An amount mismatch raises an exception.
  - Refund over-cap attempts fired in parallel: the total refunded never exceeds the captured amount.
  - Upload: a spoofed MIME type and the EICAR test file are rejected, and a download needs authorisation.
- **End-to-end tests** (Playwright, against `docker compose` with seed data): provider onboarding → payment (Razorpay test-mode fake) → verification approval. Company enquiry → quotation → acceptance → job. Matching → invitations → responses → proposal → approval → assignments visible in the provider and company portals. Check-in. Invoice → online payment and offline payment → reconciliation.
- **Manual check per module:** run `pnpm dev`, exercise the module's screens on desktop and at 360 px, and check the Swagger examples at `/api/docs`.
- **Non-functional checks:** k6 scripts for p95 latency, matching over 50,000 seeded providers in under 3 seconds, and approving a 50-line proposal in under 2 seconds. Accessibility with axe.
