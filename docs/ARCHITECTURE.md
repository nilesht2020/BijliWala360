# SkillConnect — Architecture

| Field | Value |
|---|---|
| Version | 0.1 (Proposed, awaiting approval) |
| Date | 2026-11-13 |
| Source | `docs/SRS.md` v1.0. All Section 13 defaults are accepted. |
| Related | `DATABASE.md`, `API.md`, `DEVELOPMENT_PLAN.md`, `TEST_PLAN.md` |

---

## 1. Architectural Style

**Modular monolith.** There is one codebase, and the backend runs as two kinds of process built from the same code:

| Process | Entry point | Responsibilities |
|---|---|---|
| `api` | `apps/api/src/main.ts` | HTTP REST API, Swagger, webhook ingress (store and acknowledge only). |
| `worker` | `apps/api/src/worker.ts` | BullMQ consumers, outbox relay, scheduled jobs (invitation expiry, no-show detection, gateway reconciliation, document expiry, performance recompute, SLA escalation). |

Both processes load the same NestJS modules. The worker additionally registers queue processors and schedulers, and does not open an HTTP listener apart from health checks.

Module boundaries are enforced so that the system could later be split into services:
- Each module owns its collections. **No module reads or writes another module's Mongoose model directly.** Cross-module reads go through the other module's exported service (its public API).
- Cross-module side effects go through **domain events**. These are written to the transactional outbox and delivered asynchronously.
- Synchronous cross-module writes are allowed only inside an orchestrating transaction, through exported services that accept a `ClientSession`. Allocation approval is the main case.
- `eslint-plugin-boundaries` (or `dependency-cruiser`) checks the dependency graph in CI and blocks circular imports.

---

## 2. System Context

```
                        ┌──────────────────────────────┐
  Browsers (Public,     │        React SPA (Vite)       │
  Company, Provider, ───►  served by Nginx / CDN        │
  Admin)                └──────────────┬───────────────┘
                                       │ HTTPS /api/v1 (JWT)
                        ┌──────────────▼───────────────┐
  Razorpay ──webhooks──►│      api (NestJS)             │──presigned URLs──► S3-compatible storage
  WhatsApp ──webhooks──►│                               │
                        └───┬───────────┬───────────┬──┘
                            │           │           │
                    ┌───────▼───┐ ┌─────▼─────┐ ┌───▼────────┐
                    │ MongoDB   │ │  Redis     │ │  ClamAV    │
                    │ ReplicaSet│ │ cache/rate │ │ (clamd)    │
                    └───────▲───┘ │ BullMQ     │ └───▲────────┘
                            │     └─────▲─────┘     │
                        ┌───┴───────────┴───────────┴──┐
                        │      worker (NestJS)          │──► Razorpay API, WhatsApp API,
                        └───────────────────────────────┘    SMS gateway, SMTP
```

---

## 3. Repository Layout

The repository is a pnpm workspace monorepo.

```
skillconnect/
├─ apps/
│  ├─ api/                      # NestJS backend (api + worker entry points)
│  │  ├─ src/
│  │  │  ├─ main.ts             # HTTP bootstrap
│  │  │  ├─ worker.ts           # Worker bootstrap
│  │  │  ├─ app.module.ts
│  │  │  ├─ core/               # cross-cutting infrastructure (see §5)
│  │  │  └─ modules/            # business modules (see §4)
│  │  └─ test/                  # integration and e2e tests
│  └─ web/                      # React + Vite SPA
├─ packages/
│  ├─ contracts/                # Zod schemas, enums, error codes, permission codes, DTO types shared by api and web
│  ├─ ui/                       # (optional, phase 2) shared shadcn-based components if a second app is added
│  └─ tsconfig/                 # shared strict tsconfig bases
├─ infra/
│  ├─ docker/                   # Dockerfiles (api, worker, web)
│  ├─ compose/                  # docker-compose.dev.yml, docker-compose.test.yml
│  └─ nginx/
├─ docs/                        # SRS, architecture and other documents
└─ .github/workflows/           # CI
```

**Decision D-01: shared Zod contracts.** Request and response schemas are written once in Zod in `packages/contracts`. The API validates them with `nestjs-zod` (`ZodValidationPipe`) and produces Swagger from them. The web app reuses the same schemas in React Hook Form through `zodResolver`. This removes duplicated validation between the two apps and meets the "no duplication" quality requirement.
*Alternative:* `class-validator` DTOs on the API side, with Zod on the web side. That approach is more conventional for NestJS, but the rules would have to be kept in sync by hand.

### 3.1 Backend Module Folder Convention

```
modules/allocation-proposals/
├─ allocation-proposals.module.ts
├─ schemas/allocation-proposal.schema.ts      # Mongoose schema + indexes
├─ dto/                                       # nestjs-zod DTO classes created from contracts
├─ allocation-proposals.controller.ts         # HTTP only: auth, validation, mapping
├─ allocation-proposals.service.ts            # application service (use cases, transactions)
├─ domain/                                    # pure logic: state machine, validators, policies (unit-tested, no I/O)
│  ├─ proposal-state-machine.ts
│  └─ capacity-validator.ts
├─ allocation-proposals.repository.ts         # Mongoose queries (session-aware)
├─ events.ts                                  # domain event types this module emits
└─ __tests__/                                 # unit tests
```

---

## 4. Business Modules

The modules marked ★ are not in the original module list. The SRS needs them, and keeping them separate keeps module responsibilities clear.

| # | Module | Owns (collections) | Key responsibilities | Depends on |
|---|---|---|---|---|
| 1 | **Auth** | `otp_challenges`, `refresh_tokens` | OTP, password and TOTP login, JWT issue and refresh rotation, lockout | Users, Notifications (SMS), Audit |
| 2 | **Users** | `users`, `roles`, `role_assignments` | Identity, RBAC, scoped role assignments | Audit |
| 3 | **Companies** | `companies`, `company_sites` | Company KYC, sites, commercial terms, company users | Users |
| 4 | **Professionals** | `professionals` | Profile, skills, availability calendar, lifecycle | Users, Person Registry, Documents, Service Categories |
| 5 | **Vendors** | `vendors` | Vendor profile, operating locations, lifecycle | Users, Documents, Service Categories |
| 6 | **Vendor Workers** | `vendor_workers` | Worker roster, verification, availability, worker cap | Vendors, Person Registry, Registration Payments (cap) |
| ★ | **Person Registry** | `persons` | Cross-provider identity uniqueness (BR-PRV-01) and the per-person schedule lock used for concurrency | — |
| 7 | **Service Categories** | `service_categories`, `skills` | Category tree, skills master list, required docs per skill | Documents (doc types) |
| 8 | **Registration Plans** | `registration_plans` | Fee plans, worker caps, refund policy | — |
| 9 | **Registration Payments** | `provider_registrations`, `registration_payments`, `registration_refunds` | One-time fee, Razorpay and offline payment, waivers, upgrades, verification workflow | Plans, Professionals, Vendors, Payment Gateway, Ledger |
| 10 | **Documents** | `document_types`, `documents` | Presigned upload, scanning, versioning, verification, expiry | Storage, Audit |
| 11 | **Enquiries** | `enquiries` | Lead and enquiry intake, assignment, notes | Companies, Service Categories |
| 12 | **Quotations** | `quotations` | Versioned quotes, tax calculation, PDF, acceptance | Enquiries, Jobs (create on accept), Tax |
| 13 | **Jobs** | `jobs` (positions embedded) | Job lifecycle, positions and counters | Companies, Service Categories |
| 14 | **Matching** | `match_runs` | Hard filters, weighted scoring, snapshots, overrides | Professionals, Vendors, Vendor Workers, Commitments (Assignments), Business Config |
| 15 | **Invitations** | `invitations` | Send, view, respond (idempotent), expire, withdraw | Matching, Jobs, Notifications |
| 16 | **Allocation Proposals** | `allocation_proposals` | Draft, validate, submit, approve (orchestrating transaction), reject | Invitations, Jobs, Assignments, Person Registry |
| 17 | **Assignments** | `assignments`, `commitments`, `assignment_change_requests` | Confirmed engagements, commitment holds, replacement, cancellation | Jobs, Person Registry |
| ★ | **Invoices** | `invoices`, `credit_notes` | Milestone and attendance billing, GST, numbering, PDF | Jobs, Quotations, Attendance, Tax |
| 18 | **Business Payments** | `business_payments`, `payment_allocations`, `business_refunds` | Razorpay and offline payments, maker-checker, invoice allocation, refunds | Invoices, Payment Gateway, Ledger |
| 19 | **Payment Reconciliation** | `reconciliation_runs`, `reconciliation_items`, `bank_statement_lines` | Gateway and bank reconciliation, exceptions | Business Payments, Registration Payments, Payment Gateway |
| 20 | **Notifications** | `notification_templates`, `notifications`, `notification_preferences` | Event-to-template routing, channel fallback, delivery tracking, in-app inbox | Channel adapters |
| 21 | **Attendance** | `attendance_records` | Check-in and check-out, geofence, proxy entries, confirmations, no-show | Assignments, Storage |
| 22 | **Complaints** | `complaints` | Tickets, SLA, comments, escalation | Jobs, Assignments, Business Payments |
| ★ | **Ratings & Performance** | `ratings`, `performance_snapshots` | Ratings, performance score recompute | Assignments, Attendance, Complaints |
| 23 | **Reports** | `report_exports` | Read models and aggregation pipelines, async exports | Read-only access to all modules through query services |
| 24 | **Audit Logs** | `audit_logs` | Append-only audit trail and search | — |
| ★ | **Business Config** | `business_settings` | Typed, versioned business configuration, Redis-cached | — |

### 4.1 Payment Gateway and Ledger (shared financial core)
Registration payments and business payments are separate modules with separate collections (BR-FIN-01). Two pieces of infrastructure sit under `core/finance` and are shared by both:

- **PaymentGatewayModule**: the Razorpay adapter (orders, payments, refunds, settlements), signature verification, and webhook ingress. The ingress verifies the HMAC signature, stores the event in `webhook_events` (unique on `eventId`), returns 200, and enqueues it. The worker routes each event by `order.notes.domain` (`REGISTRATION` or `BUSINESS`) to that domain's handler.
- **LedgerModule**: an append-only `ledger_entries` collection, with a `book` field of `REGISTRATION` or `BUSINESS` so that each book reconciles separately. Postings are balanced in double-entry form and created in the same transaction as the payment state change.

---

## 5. Core (Cross-Cutting) Infrastructure — `apps/api/src/core`

| Component | Purpose |
|---|---|
| `config/` | Typed environment config with Zod validation at boot. The process fails fast if a variable is missing. Holds secrets and infrastructure settings only. |
| `database/` | Mongoose connection and a `TransactionRunner` (`withTransaction(fn)`). The runner uses `readConcern: snapshot` and `writeConcern: majority`, and retries `TransientTransactionError` and `UnknownTransactionCommitResult` up to a configured number of times. |
| `redis/` | ioredis client for cache, rate limiting and BullMQ connection. |
| `queue/` | BullMQ queue registry, default job options (attempts, exponential backoff, `removeOnComplete`), and dead-letter handling. |
| `outbox/` | `OutboxService.add(event, session)` writes to `outbox_events` inside the caller's transaction. `OutboxRelay` runs in the worker: it polls with a claim-by-update (lease) pattern, publishes to BullMQ and marks the event dispatched. Delivery is at least once, so consumers are idempotent by `eventId`. |
| `idempotency/` | The `@Idempotent()` decorator and interceptor. They store `(key, userId, route) → requestHash, status, response` with a 24-hour TTL. The same key with a different payload returns `422 IDEMPOTENCY_KEY_REUSED`. A key that is still in progress returns `409 REQUEST_IN_PROGRESS`. |
| `auth/` | `JwtAuthGuard`, `PermissionsGuard` (`@RequirePermissions('allocation.approve')`), `ScopeGuard` (company, vendor or self ownership), and the `@CurrentUser()` decorator. |
| `http/` | Global `ResponseEnvelopeInterceptor` that produces `{success, data, meta}`, global `AllExceptionsFilter` that maps errors to `{success:false, error, requestId}`, `RequestIdMiddleware`, Helmet, CORS, and the throttler backed by Redis. |
| `errors/` | `DomainError` base class with a stable `code` (from `packages/contracts/error-codes.ts`) and an HTTP status mapping. |
| `logging/` | `nestjs-pino` with request ID and user ID binding, and redaction paths for PII and secrets. |
| `audit/` | `AuditService.record(entry, session?)` plus `@Audited()` interceptor for simple CRUD. Complex use cases call the service explicitly with before and after states. |
| `storage/` | S3 adapter for presigned PUT and GET, `HeadObject`, and moving objects from `quarantine/` to `clean/`. |
| `scanning/` | ClamAV (clamd) client used by the document scan worker. |
| `crypto/` | AES-256-GCM field encryption with versioned keys from environment or KMS, and HMAC-SHA256 for searchable hashes (ID number, mobile). |
| `sequence/` | Atomic `counters` collection for job numbers and invoice numbers (gap-free within a transaction). |
| `business-config/` | The `BusinessConfigService.get<K>(key)` facade. Values are typed by a Zod registry in contracts and cached in Redis, and invalidated on update through pub/sub. |
| `channels/` | Adapter interfaces and implementations for `SmsProvider`, `WhatsAppProvider` and `EmailProvider`. Test and dev builds use a console or Mailpit adapter. |
| `health/` | `@nestjs/terminus` checks for Mongo, Redis and storage. |

---

## 6. Key Design Mechanisms

### 6.1 RBAC Model
- **Permission codes** are static and defined in `packages/contracts/permissions.ts`, for example `job.create`, `allocation.propose`, `allocation.approve`, `payment.verify`, `refund.approve`, `registration.verify`, `registration.waive`, `config.manage` and `audit.read`.
- **Roles** are database documents that bundle permissions. System roles are seeded and cannot be deleted.
- **Role assignments** link `(userId, roleId, scope)`, where scope is `{ type: 'PLATFORM' }`, `{ type: 'COMPANY', companyId, siteIds? }` or `{ type: 'VENDOR', vendorId }`.
- The JWT carries `sub`, a `roles` digest and a `permVersion`. The full permission set is resolved per request from a Redis cache keyed by `userId:permVersion`. Changing a role bumps the version, which takes effect immediately without waiting for tokens to expire.
- **Scope enforcement** happens at two layers: the `ScopeGuard` for route-level ownership, and repository filters that always add `companyId` or `vendorId` for non-platform users. This defence in depth prevents insecure direct object reference (IDOR) attacks.

### 6.2 State Machines
Each lifecycle has a pure `transition(state, event) → newState | DomainError` table in its `domain/` folder. The lifecycles are provider, worker, document, enquiry, quotation, job, invitation, proposal, assignment, invoice, payment, refund and complaint. Persistence always uses a **conditional update** of the form `updateOne({_id, status: from, version}, {$set:{status: to}, $inc:{version:1}})`. If `matchedCount === 0`, the service returns `409 STATE_CONFLICT`. This makes every transition safe under concurrency and idempotent when it is retried.

### 6.3 Allocation Concurrency Design (FR-ALC-04, 06, 07 and BR-ALC-04, 05, 06)

Three independent guards apply. Each one is enforced in the database, not only in application code.

1. **Position capacity.** Each embedded job position stores `required`, `held` and `confirmed` counts.
   - When a proposal is *submitted*, the system reserves `n` places for the position with a conditional update that only succeeds while `held + confirmed + n <= required`. The filter uses `{_id: jobId, positions: {$elemMatch: {_id: posId, available: {$gte: n}}}}`, and the update is `$inc: {"positions.$.held": n, "positions.$.available": -n}`. The update keeps the denormalised field `available = required - held - confirmed` in step.
   - When a proposal is *approved*, the reserved places move from `held` to `confirmed` (`$inc held:-n, confirmed:+n`).
   - When a proposal is rejected or cancelled, the reservation is released (`$inc held:-n, available:+n`).
2. **Vendor offered headcount.** Each vendor invitation response stores `offeredHeadcount`, `reservedCount` and `confirmedCount`. Reserving places on the vendor uses the same conditional increment pattern.
3. **Person double-booking.**
   - Every person, whether a professional or a vendor worker, maps to one `persons` document. That document has a `scheduleVersion` field.
   - Every hold or confirmation is a `commitments` document: `{personId, assignmentId?, proposalId, status: HELD|CONFIRMED|RELEASED, startDate, endDate, daysOfWeek, shiftStartMin, shiftEndMin}`.
   - Within the transaction, for each person, the service first *writes* `persons.updateOne({_id}, {$inc:{scheduleVersion:1}})`. If two transactions touch the same person, this write makes the second one fail with a MongoDB `WriteConflict`; it is then retried, and on retry it sees the first transaction's commitment. Next the service reads the person's active commitments that overlap the date range and runs the pure overlap check (dates, weekdays and shift windows, including shifts that cross midnight). Only if there is no overlap does it insert the new commitment.
   - A plain unique index cannot express overlap between time ranges. Writing to the person document serialises all scheduling for one person, which is the standard MongoDB pattern for this, and it is cheap.

**Submitting a proposal** (`DRAFT → PENDING_APPROVAL`) runs as one transaction: validate the lines, reserve position places, reserve vendor places, create `HELD` commitments, and set the status conditionally.

**Approving a proposal** (`PENDING_APPROVAL → APPROVED`) runs as one transaction:
1. Set the status conditionally: `{_id, status: PENDING_APPROVAL, version}` changes to `APPROVED`. If this fails, return `409`.
2. Check separation of duties. With `requireSeparateApprover` on, the approver must not be `proposal.createdBy`.
3. Revalidate eligibility. The person's status, document expiry and the invitation response's state are checked again, because they may have changed after submission.
4. Bump each person's `scheduleVersion`, then turn the person's `HELD` commitment into `CONFIRMED`. If the hold is missing or has been released, the approval fails.
5. Move the position counts from `held` to `confirmed`, and move the vendor response from `reservedCount` to `confirmedCount`.
6. Insert assignments. A unique index on `{jobId, personId, status in active}` catches a person who appears twice on the same job.
7. Update the job status: `PARTIALLY_STAFFED` or `STAFFED`.
8. Write audit entries and the `allocation.approved` and `assignment.confirmed` outbox events.
9. Commit. Notifications go out after the commit, through the outbox relay.

Approval also carries an `Idempotency-Key`, so a double-click or network retry returns the original result.

**Why hold at submission?** If places were reserved only at approval, an admin could submit two proposals that both look valid and only one could ever be approved. Holding places at submission surfaces the conflict early. It also satisfies FR-ALC-04(b), which forbids overlap with commitments held in another pending proposal.

### 6.4 Invitation Response Idempotency (FR-INV-07)
- A response is sent as `PUT /invitations/:id/response` with an `Idempotency-Key` header.
- The service compares the incoming payload with the latest response. If they are equal, it is a no-op and returns the current version.
- Otherwise it appends a new version to `responses[]` with `responseVersion+1`. The update is conditional on `{status ∈ [SENT, VIEWED, RESPONDED_*], deadline > now, lockedByProposal: false}`.
- `lockedByProposal` becomes true when an *approved* proposal consumes the response. Responses can no longer change after that point.
- **No code path in the Invitations module writes to assignments.** The Assignments module exports no create method to Invitations; only the Allocation Proposals approval transaction can create assignments. This is enforced by the module dependency rules in §1.

### 6.5 Payment Flows

**Online payment (registration or business):**
```
Client ──POST /…/payments/online (Idempotency-Key)──► API
API: create local payment {status: CREATED, amount from server-side invoice or plan, never client input}
API ──► Razorpay Orders API (receipt = local paymentId, notes.domain, notes.paymentId)
API ◄── order_id ; save gatewayOrderId ; return checkout params
Client ── Razorpay Checkout ──► success handler ──POST /…/payments/:id/verify {razorpay_payment_id, signature}
API: verify HMAC(order_id|payment_id) → status PENDING_CONFIRMATION (UI shows "processing")
Razorpay ──webhook payment.captured / order.paid──► /webhooks/razorpay
API: verify signature on raw body → insert webhook_events{eventId unique} → 200
Worker: route by notes.domain → transaction:
        conditional update payment {status ∉ final} → SUCCESS
        allocate to invoice(s) / mark registration paid
        ledger postings ; outbox payment.succeeded
```
- **Amount integrity:** the server computes the amount and compares it with the amount in the webhook. A mismatch is flagged as a reconciliation exception and the payment is not marked successful.
- **Monotonic statuses:** a final state (`SUCCESS`, `FAILED`, `REFUNDED`) can never revert. Events that arrive late are recorded and otherwise ignored.
- **Stuck payments:** a sweeper job polls Razorpay for payments still `CREATED` or `PENDING_CONFIRMATION` after N minutes. This covers webhooks that never arrive.

**Offline payment:** recording a payment creates `PENDING_VERIFICATION` with the proof document. A different user with `payment.verify` then verifies it. In one transaction this sets the status to `SUCCESS`, creates allocations, updates the invoice balance and writes ledger postings. Cheques move through `RECEIVED → DEPOSITED → CLEARED`, and the payment becomes `SUCCESS` only on `CLEARED`. A bounced cheque goes to `FAILED` with a reversing ledger entry if postings were made.

**Refund:** the guard `refundedAmount + amount <= capturedAmount` is a conditional `$inc` on the payment document, in the same transaction as the refund record. A refund above the threshold enters `PENDING_APPROVAL` and needs a second approver before it is sent to Razorpay. Gateway calls happen outside the transaction: commit the `PROCESSING` state first, then call the gateway from a worker with the refund ID as Razorpay's idempotency reference. Finally the outcome is applied.

### 6.6 Transactional Outbox and Events
- Events are named `<aggregate>.<pastTenseVerb>`, for example `registration.approved`, `invitation.sent`, `invitation.responded`, `allocation.approved`, `assignment.confirmed`, `assignment.replaced`, `payment.succeeded`, `payment.verified`, `refund.processed`, `complaint.sla_breached` and `document.expiring`.
- Notification consumers, the audit projection and report read-model updaters subscribe through BullMQ queues.
- Each consumer records `processedEventIds` (a unique index per consumer), which makes it idempotent.

### 6.7 File Upload Security (FR-DOC-02/03)
1. The client calls `POST /documents/upload-intent {typeCode, ownerRef, fileName, size, mime}`. The server validates the document type rules, ownership and size limit, creates a `documents` record with status `PENDING_UPLOAD`, and returns a presigned PUT URL. The URL is for `quarantine/{docId}`, uses content-type and content-length conditions, and expires in 5 minutes.
2. The client uploads the file directly to storage.
3. The client calls `POST /documents/:id/complete`. A scan job is queued.
4. The worker does a `HeadObject` to check the size, sniffs the first bytes to confirm the MIME type with `file-type`, streams the file to clamd, and on a clean result copies it to `clean/{docId}` and sets `UPLOADED`. Otherwise it sets `REJECTED_MALWARE` or `REJECTED_TYPE` and deletes the object.
5. Downloads use `GET /documents/:id/download-url`. The server authorises the request and returns a presigned GET URL that expires in 60 seconds, with a `Content-Disposition: attachment` header for non-images.

The bucket blocks public access, and every object is encrypted with server-side encryption (SSE).

### 6.8 Matching Engine
- The engine is a MongoDB aggregation per position, with `$geoNear` as the first stage. It uses a 2dsphere index on the service location, and applies the radius as `min(provider radius, configured maximum)`. A `$match` stage then applies status, skill IDs and document validity flags. Document validity flags are kept up to date on the provider when documents change.
- Commitment and availability checks are run in the application on the reduced candidate set (usually at most a few hundred). They use a single batched commitments query with `personId $in` and an overlapping date range.
- Scoring is a pure function, `score(candidate, position, weights)`, that returns a total plus a breakdown. The weights come from `BusinessConfig['matching.weights']`.
- The full run, including inputs, the weights version, the candidates with their breakdowns, any exclusions with reasons, and any overrides, is stored in `match_runs` (FR-MAT-04).
- Vendor candidates are aggregated from eligible workers, grouped by vendor, giving an `eligibleWorkerCount` and the best worker score.

### 6.9 Business Configuration (no hard-coding)
- Typed keys are declared in `packages/contracts/business-config.ts`. Each key has a Zod schema and a default, for example `otp.ttlSeconds`, `invitation.responseWindowHours`, `matching.weights`, `matching.maxRadiusKm`, `attendance.geofenceMeters`, `attendance.noShowGraceMinutes`, `allocation.requireSeparateApprover`, `refund.secondApprovalThresholdPaise`, `complaint.slaHours.{LOW,MEDIUM,HIGH,CRITICAL}`, `invoice.prefix`, `notification.quietHours` and `payment.offlineMethodsEnabled`.
- Stored values are validated against the schema on write and versioned. Every change is audited.
- Values that belong to a specific entity live on that entity, not in the global settings. Plan fees live in `registration_plans`, tax rates on SAC tax rules, and company commercial terms on `companies`.

### 6.10 Error Handling and Response Format
```jsonc
// success
{ "success": true, "data": { … }, "meta": { "page": 1, "pageSize": 20, "total": 134 } }
// error
{ "success": false,
  "error": { "code": "ALLOCATION_CAPACITY_EXCEEDED", "message": "Position P2 has 1 open slot; 2 requested.",
             "details": [{ "lineId": "…", "field": "positionId" }] },
  "requestId": "req_01J…" }
```
- `DomainError` subclasses map to these HTTP statuses: 400 validation, 401, 403, 404, **409 state or concurrency conflict**, **422 business rule violation**, 429 and 500.
- Unknown errors are logged with their stack trace and returned as a generic 500 that never leaks internals.

### 6.11 Logging, Observability and Audit
- Logs are pino JSON lines with `requestId`, `userId`, `module` and `latencyMs`. Redaction covers `authorization`, `password`, `otp`, `*.bankAccount`, `*.idNumber` and `razorpay_signature`.
- Metrics use `prom-client` at `/metrics`, which is internal only. They cover HTTP request duration, BullMQ queue depth and failures, outbox lag and transaction retries.
- Audit logging is separate from application logs. It is stored durably in MongoDB, never updated, and has a 7-year TTL on non-financial entries only.

---

## 7. Security Architecture (summary)

| Concern | Control |
|---|---|
| AuthN | OTP login for providers and companies, password + TOTP for admins. JWT access token (15 min, RS256 with key rotation through a `kid` header). Refresh token: an opaque random 256-bit value, stored hashed, rotated on each use, with family revocation on reuse, delivered in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`. |
| AuthZ | Permission guard plus scope guard plus repository scoping (§6.1). |
| Input | Zod with strict objects (unknown keys rejected), a global sanitiser that strips `$` and `.` from keys, and size limits on request bodies. |
| Rate limits | Redis throttler. OTP send: 3 per 15 minutes per number and 10 per hour per IP. Login: 5 per minute. Global: 300 per minute per user. |
| Data | TLS. MongoDB encryption at rest. Field-level AES-GCM for bank account, ID numbers and TOTP secrets. HMAC hashes for duplicate lookup. |
| Files | §6.7 |
| Webhooks | HMAC on the raw body, recorded event IDs and replay protection. Endpoints are excluded from the JWT guard only. |
| Secrets | Environment variables or a secret manager. Nothing is committed. `.env.example` lists the keys only. |
| Headers | Helmet, a strict Content-Security-Policy on the SPA (Razorpay checkout domain allowed), and an allowlist of CORS origins. |
| PII access | Revealing sensitive fields, for example by downloading a document, is audited. |

---

## 8. Frontend Architecture (`apps/web`)

### 8.1 Stack and Structure
React 18, TypeScript in strict mode, Vite, Tailwind, shadcn/ui (Radix), TanStack Query, React Hook Form, Zod (from `@skillconnect/contracts`), React Router (data routers), and Axios.

```
apps/web/src/
├─ app/                 # router, providers (QueryClient, Auth, Theme), layouts
├─ routes/
│  ├─ public/           # home, categories, category detail, become-a-provider, enquiry, login
│  ├─ company/          # dashboard, enquiries, quotations, jobs, attendance, invoices, payments, complaints, users, sites
│  ├─ provider/         # onboarding wizard, profile, documents, registration payment, invitations, assignments, attendance, workers (vendor)
│  └─ admin/            # verification queue, plans, categories, enquiries, quotations, jobs, matching, invitations, proposals, assignments, finance, reconciliation, complaints, reports, audit, config, users and roles
├─ features/<module>/   # api.ts (query and mutation hooks), components/, hooks/, schemas re-exported from contracts
├─ components/
│  ├─ ui/               # shadcn primitives (generated)
│  ├─ data-table/       # reusable server-paginated table (TanStack Table): filters, column visibility, export
│  ├─ forms/            # FormField wrappers, MoneyInput (paise↔₹), PhoneInput, OtpInput, DateRangePicker, FileUpload (presigned flow)
│  ├─ layout/           # AppShell, Sidebar, Topbar, PageHeader, EmptyState, StatusBadge
│  └─ marketing/        # ServiceCategoryCard, HeroSearch, CategoryGrid
├─ lib/                 # apiClient (axios + refresh interceptor + error envelope unwrapping), queryKeys, formatters (INR, IST dates), permissions (useCan)
└─ styles/
```

### 8.2 Patterns
- **Authentication:** the access token is held in memory only. On a 401 the axios interceptor runs a single-flight refresh using the cookie, then retries the request. On a hard refresh, the app calls `/auth/refresh` during bootstrap.
- **Authorisation in the UI:** `useCan('allocation.approve')` hides or disables actions. The server remains the authority.
- **Server state:** React Query with a query-key factory per feature. Mutations invalidate affected keys. Optimistic updates are used only for non-financial actions such as marking a notification read.
- **Idempotency:** mutation hooks for payments, invitation responses and proposal approval generate a UUID `Idempotency-Key` when the user acts. Retries of the same action reuse the key.
- **Forms:** React Hook Form with `zodResolver(contractSchema)`. Server 422 `details[]` errors are mapped onto field errors.
- **Tables:** one `DataTable` component with URL-synced filters and pagination (`?page=&status=`), used across all admin lists.
- **Responsive design:** provider routes are designed mobile first, with bottom navigation under 768 px. Admin pages use a collapsible sidebar, and tables switch to stacked cards on small screens.
- **Code splitting:** each route group (`public`, `company`, `provider`, `admin`) is lazy loaded.

### 8.3 Visual Design System (original)
- Neutral white and light-grey surfaces, one brand accent (a deep indigo is proposed; final colour to be confirmed), and semantic status colours.
- Typography: Inter (UI) with a tabular-numbers variant for financial figures, on a 4 px spacing scale.
- Rounded cards (`rounded-2xl`) with subtle shadows, and large 4:3 imagery for service categories on public pages.
- Categories are presented as a grid of image cards on the home page, with sub-category chips on the category page.
- All brand assets and illustrations are original or properly licensed stock. Nothing is copied from third-party marketplaces.

---

## 9. Deployment Topology

| Environment | Composition |
|---|---|
| Local dev | `docker-compose.dev.yml`: `mongo` (single-node replica set `rs0`, which is required for transactions), `redis`, `minio`, `clamav`, `mailpit`. `api`, `worker` and `web` run on the host with hot reload. |
| CI | Same services through compose or Testcontainers. Integration tests use a real replica set. |
| Staging / Prod | Containers: `web` (Nginx serving static files), `api` (2 or more replicas behind a load balancer), `worker` (1 or more replicas; schedulers use BullMQ repeatable jobs, which are safe with several workers). Managed MongoDB (Atlas or a self-hosted 3-node replica set), managed Redis, S3 or R2, and ClamAV as a sidecar or service. |

- **Images:** multi-stage Dockerfiles that run as a non-root user and include a health check.
- **Configuration:** environment variables are validated at boot.
- **Migrations and seeding:** `migrate-mongo` handles index creation and seeds for roles, permissions, document types, default config and the default categories. Schemas set `autoIndex: false` in production, so index creation runs through migrations.

---

## 10. Technical Ambiguities and Decisions Needing Approval

| # | Topic | Ambiguity | Proposed resolution |
|---|---|---|---|
| T-01 | Contracts | Validation could use class-validator or Zod. | **Shared Zod with nestjs-zod** (D-01). |
| T-02 | Overlap check | A unique index cannot detect overlapping time ranges. | **Per-person `scheduleVersion` write lock plus an overlap check inside the transaction** (§6.3). |
| T-03 | When capacity is reserved | The SRS says validate "at submission and again at approval". It does not say whether submission reserves capacity. | **Reserve (`HELD`) at submission** and confirm at approval (§6.3). |
| T-04 | Partial availability (FR-INV-05) | The model for a professional who is available only on some job dates is undefined. | Store `availableDates[]` on the response. An allocation line may carry a date subset, and its commitment covers only those dates. **Phase 1:** whole-period allocation only, with the partial dates captured for information. Full partial allocation comes in phase 2. |
| T-05 | Vendor worker proposals | A vendor may name specific workers in its response, or the admin may choose them. | The admin's proposal must name specific workers. If the vendor named workers, they are preselected. Otherwise the admin picks from the vendor's eligible workers, and the count must not exceed `offeredHeadcount`. |
| T-06 | Shift model | Shifts can be per position or per date. | Each position has **one** shift window (start and end minutes, may cross midnight) and a schedule given as a date range plus weekdays plus excluded dates. Rotating shifts are out of the MVP. |
| T-07 | Invoices vs. payments module | Invoices are not in the given module list. | Invoices become a **separate module**, with Business Payments depending on it. |
| T-08 | Ledger separation | "Separate ledger" could mean separate collections or separate books. | **One `ledger_entries` collection with a `book` discriminator** and separate account charts. Reports filter by book. |
| T-09 | Registration payment as "registration" vs. "payment" | One module for both the verification workflow and the payment, or two? | The **Registration Payments** module owns `provider_registrations` (the workflow record with the plan snapshot) and the payments. The verification decision endpoints live there too, guarded by `registration.verify`. |
| T-10 | Worker logins | Workers can log in optionally (A-04). | Workers who have a mobile number get a user account with the `VENDOR_WORKER` role, which is OTP only and can see only their own assignments and attendance. |
| T-11 | Provider rate vs. company rate | Each position needs both rates. | A position holds `billRate` (company-facing, from the quotation) and `payRate` (provider-facing, set by an admin). Invitations show `payRate` only when `showPayRate` is set. |
| T-12 | PDF generation | Choice of library. | **Playwright with headless Chromium** rendering an HTML template, in the worker. It produces better GST invoice layouts than pdfkit. The worker image is about 300 MB larger. *Alternative:* `pdfmake`, which is lighter. |
| T-13 | Search | Admin search across entities. | MongoDB text indexes and prefix regex on indexed fields in the MVP. Atlas Search or OpenSearch in phase 2. |
| T-14 | Time zones | Commitments and attendance need consistent dates. | Store instants in UTC. Store calendar dates as `YYYY-MM-DD` strings in the site's time zone (default IST). Store shift times as minutes from midnight in the site's time zone. |
| T-15 | Notification provider | The SMS and WhatsApp vendors are unspecified. | Adapter interfaces. The concrete vendors (for example MSG91 and Meta Cloud API) are chosen at integration time. |
| T-16 | Company onboarding | Do companies pay a registration fee? | No. Only providers pay registration fees. |
