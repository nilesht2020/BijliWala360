# Bijli Wala — Test Plan

| Field | Value |
|---|---|
| Version | 0.2 (Proposed) |
| Date | 2026-11-18 |
| Source | `SRS.md` v2.0 (including the acceptance criteria in §19.3, from `bijli wala .docx` §16), `ARCHITECTURE.md`, `DATABASE.md`, `API.md` |

---

## 1. Objectives
1. Prove that the allocation and financial invariants hold **under concurrency and retries**:
   - No over-allocation.
   - No double-booking.
   - An invitation response never creates an assignment.
   - Exactly-once financial effects.
   - The refunded amount never exceeds the captured amount.
2. Verify every functional requirement (FR) and business rule (BR) in the SRS through traceable tests.
3. Prevent regressions through CI gates.
4. Verify the non-functional targets: performance, security, accessibility and responsiveness.

---

## 2. Test Levels and Tools

| Level | Scope | Tools | Runs |
|---|---|---|---|
| **Static** | Types, lint, module boundaries | `tsc --noEmit` (strict), ESLint, `eslint-plugin-boundaries`, Prettier | Pre-commit and CI |
| **Unit (API)** | Pure domain code (state machines, validators, scoring, overlap, tax, money) and services with mocked repositories and adapters | Jest, ts-jest, `fast-check` (property-based tests) | CI on every push |
| **Unit (Web)** | Hooks, formatters, form schemas, components | Vitest, React Testing Library, MSW, `@testing-library/user-event` | CI on every push |
| **Integration (API)** | Controller → service → MongoDB (real **replica set**) + Redis + BullMQ. External adapters are faked (Razorpay, SMS, WhatsApp, S3 through MinIO, ClamAV real or stub). | Jest, supertest, Testcontainers (`mongo:7` started with `--replSet`, `redis:7`, `minio`), or `mongodb-memory-server` `MongoMemoryReplSet` for speed | CI on every push (parallel shards) |
| **Contract** | The Swagger output matches the contracts, and there are no breaking changes | `openapi-diff` against `main` | CI on pull requests |
| **End-to-end** | Critical user journeys across portals | Playwright (Chromium, plus WebKit mobile viewport 390×844), docker-compose stack with seed data | CI nightly, plus pull requests that carry the `e2e` label |
| **Performance** | Latency and throughput against the NFRs | k6 with seeded datasets (50,000 providers, 5,000 jobs) | Weekly, and before each release |
| **Security** | Authentication, authorisation, IDOR, injection, uploads, headers, dependencies | Integration suites, OWASP ZAP baseline scan, `pnpm audit` / Snyk, Trivy image scan | CI (audit, Trivy); ZAP before each release |
| **Accessibility** | WCAG 2.1 AA | `@axe-core/playwright` on key pages | Nightly |
| **Manual / UAT** | Role-based scripts, real Razorpay test mode, WhatsApp sandbox | Test case sheets per role | Before each release |

### 2.1 Test Data and Fixtures
- `apps/api/test/factories/`: typed builders for every aggregate, for example `aJob().withPosition({required: 2}).build()`.
- `apps/api/test/helpers/`: `loginAs(role, scope)`, which mints a JWT with the given permissions. Also `withIdempotencyKey()`, `signRazorpayWebhook(body)` and `freezeTime()`.
- Each integration test file runs against a fresh database (`db_${workerId}_${file}`) and drops it afterwards. Indexes are created through the same migration code used in production, so tests check the real unique and partial indexes.
- **Fakes:**
  - `FakeRazorpayGateway`: an in-memory orders, payments and refunds store. It can emit webhook payloads.
  - `FakeSmsProvider` and `FakeWhatsAppProvider`: capture outgoing messages and expose the last OTP sent.
  - `FakeClamd`: returns infected for the EICAR signature.

### 2.2 Coverage Gates (CI fails below these)
| Area | Line / branch |
|---|---|
| `modules/*/domain/**` | 90% / 90% |
| `modules/*/*.service.ts` | 80% / 75% |
| `core/finance/**`, `allocation-proposals`, `invitations`, `assignments` | 90% / 85% |
| Web `features/**` hooks and forms | 70% / 60% |
| State machine transition tables | **100%** of the allowed and forbidden transitions |

---

## 3. Critical Scenario Catalogue

### 3.1 Allocation Concurrency and Integrity (highest priority)
| ID | Scenario | Expected |
|---|---|---|
| ALC-C01 | Two proposals each hold the last place of a position, and both are submitted at once (`Promise.all`, 20 iterations) | Exactly one goes to `PENDING_APPROVAL`; the other gets 422 `ALLOCATION_CAPACITY_EXCEEDED`. `held + confirmed <= required` always. |
| ALC-C02 | Two proposals for different jobs contain the same person on overlapping dates and shifts, and are submitted at once | One succeeds; the other gets 422 `COMMITMENT_CONFLICT`. At most one active commitment exists for that person and slot. |
| ALC-C03 | Two approvers approve the same proposal at once | One gets 200; the other gets 409 `STATE_CONFLICT`. Exactly N assignments exist. |
| ALC-C04 | The same approval is sent twice with the same `Idempotency-Key`, both in parallel and one after the other | Identical 200 bodies. Assignments are not duplicated. |
| ALC-C05 | A person's document expires between submission and approval | Approval fails with 422 `PROVIDER_NOT_ELIGIBLE` and the whole transaction rolls back: no partial assignments, counters unchanged. |
| ALC-C06 | Approval fails partway (fault injection in the assignment insert) | The transaction aborts. The proposal stays `PENDING_APPROVAL`. Holds are intact, and no outbox event is written. |
| ALC-C07 | A vendor offers 2 workers and the admin proposes 3 | 422 `VENDOR_HEADCOUNT_EXCEEDED`. |
| ALC-C08 | Two proposals for the same vendor response together exceed `offeredHeadcount` (concurrent submits) | One succeeds. `reservedCount + confirmedCount <= offeredHeadcount`. |
| ALC-C09 | The same person is proposed twice on one job (two lines, or a second proposal) | 422 `DUPLICATE_PERSON_IN_JOB`. The partial unique index blocks it even if the validator is bypassed. |
| ALC-C10 | `requireSeparateApprover=true` and the creator approves their own proposal | 403 `SELF_APPROVAL_FORBIDDEN`. When the flag is false, the approval is allowed. |
| ALC-C11 | Rejecting or cancelling a proposal | All `HELD` commitments become `RELEASED`, `held` is decremented and the vendor `reservedCount` is released. The candidates can be proposed again. |
| ALC-C12 | Replacement proposal approved | Old assignment `REPLACED`, its commitment `RELEASED`, new assignment `CONFIRMED`. `confirmed` is unchanged. All of this is atomic. |
| ALC-C13 | Property test: random sequences of submit, approve, reject and cancel across 3 jobs and 10 persons, run concurrently | The invariants always hold: no overlapping active commitments per person, `confirmed <= required`, and every assignment is backed by a `CONFIRMED` commitment and an `APPROVED` proposal. |
| ALC-C14 | Proposal line references a `DECLINED`, `EXPIRED` or `WITHDRAWN` invitation | Blocking error `RESPONSE_NOT_INTERESTED`. |
| ALC-C15 | A proposal has unacknowledged warnings and is submitted | 422 `UNACKNOWLEDGED_WARNINGS`. |

### 3.2 Invitations
| ID | Scenario | Expected |
|---|---|---|
| INV-01 | A professional responds INTERESTED | Status `RESPONDED_INTERESTED`, availability snapshot stored. **The `assignments` and `commitments` counts are unchanged (asserted).** |
| INV-02 | The same response is replayed with the same key ×5 in parallel | One version is stored. All responses are identical. |
| INV-03 | Same key with a different body | 422 `IDEMPOTENCY_KEY_REUSED`. |
| INV-04 | The response changes from INTERESTED to DECLINED before the deadline | `responseVersion` 2, with history kept. |
| INV-05 | A response arrives after the deadline, or on a locked invitation | 422 `INVITATION_DEADLINE_PASSED` / `INVITATION_LOCKED`. |
| INV-06 | A vendor names a committed or ineligible worker | 422 `WORKER_NOT_ELIGIBLE` with details. |
| INV-07 | A duplicate invitation is sent to the same provider for the same position | It is skipped (partial unique index). The response lists it in `skipped[]`. |
| INV-08 | The expiry scheduled job runs | Invitations past their deadline in `SENT` or `VIEWED` become `EXPIRED`. Responded invitations are untouched. |
| INV-09 | Static check: the Invitations module does not import the assignment-creation API | A dependency-cruiser rule fails CI if it does. |

### 3.3 Matching
| ID | Scenario | Expected |
|---|---|---|
| MAT-01 | Each hard filter (status, skill, documents expired, radius, calendar, commitment overlap, blocked by company) has a fixture | The provider is excluded with the correct reason code. |
| MAT-02 | Scoring weights change in config | The ranking changes. The snapshot records the weights version. |
| MAT-03 | A distance override with justification | Allowed and audited. An availability override returns 422 `OVERRIDE_NOT_PERMITTED`. |
| MAT-04 | A vendor has 5 workers, of whom 2 are committed and 1 has expired documents | `eligibleWorkerCount = 2`. |
| MAT-05 | `score()` property tests | The score is monotonic in rating and distance, bounded to [0, 100], and deterministic. |

### 3.4 Commitment Overlap (unit, table-driven and property-based)
Cases:
- Same date with disjoint shifts.
- Same date with touching shifts (10:00–18:00 and 18:00–22:00): no overlap.
- Overnight 22:00–06:00 against 05:00–09:00 on the next day: overlap.
- Different weekday sets: no overlap.
- An excluded date removes the overlap.
- Containment of one date range inside another.
- Single-day jobs.
- Year boundaries.

### 3.5 Payments and Webhooks
| ID | Scenario | Expected |
|---|---|---|
| PAY-01 | A webhook with an invalid signature | 401, nothing stored or processed. |
| PAY-02 | The same `payment.captured` event delivered 5 times, in parallel and sequentially | One `webhook_events` record. The payment becomes `SUCCESS` once. One ledger journal. One notification. |
| PAY-03 | `payment.failed` arrives after `payment.captured` | Status stays `SUCCESS`. The event is recorded as `IGNORED`. |
| PAY-04 | The webhook amount differs from the local amount | Not marked successful. A reconciliation exception is created. |
| PAY-05 | The client signature verify call arrives before the webhook | `PENDING_CONFIRMATION`, then `SUCCESS` when the webhook arrives. Doing it in the reverse order gives the same final state. |
| PAY-06 | No webhook arrives within N minutes | The sweeper fetches the payment from the gateway and finalises it. |
| PAY-07 | The online order amount is tampered with on the client | The server ignores the client amount; the order uses the invoice balance or the plan fee. |
| PAY-08 | Offline payment verified by the same user who recorded it | 403 `MAKER_CHECKER_VIOLATION`. |
| PAY-09 | A duplicate UTR or cheque reference for the same bank | 422 `DUPLICATE_PAYMENT_REFERENCE` (index-backed). |
| PAY-10 | Cheque `RECEIVED→DEPOSITED→BOUNCED` | Never `SUCCESS`. The invoice balance is unchanged. Any provisional ledger entries are reversed. |
| PAY-11 | Allocating more than the invoice balance, and two concurrent allocations | 422 `AMOUNT_EXCEEDS_BALANCE`. The balance never goes negative. |
| PAY-12 | 10 concurrent partial refunds whose sum exceeds the captured amount | Refunds succeed until the cap, and the rest get 422 `REFUND_EXCEEDS_CAPTURED`. `refundedPaise <= capturedPaise`. |
| PAY-13 | Refund above the threshold | `PENDING_APPROVAL`. The requester cannot approve it. A different approver can, and the gateway is called once even if the worker job retries. |
| PAY-14 | A ledger journal does not balance | The ledger service throws and the transaction aborts. |
| PAY-15 | Registration vs. business domain routing | A `notes.domain` of `REGISTRATION` never touches `business_payments`, and the reverse. Ledger books stay separate. |
| PAY-16 | Gap-free invoice numbering under 50 concurrent issues, with 1 fault-injected rollback | The numbers are contiguous with no gaps or duplicates. |
| PAY-17 | GST calculation for intra-state and inter-state supply, with rounding | Matches golden fixtures, half-up rounding at line level. |

### 3.6 Reconciliation
- **REC-01:** a gateway report containing payments that are missing locally, missing at the gateway, mismatched in amount and mismatched in status gives the correct `result` for each item.
- **REC-02:** a bank statement import with a column mapping auto-matches by UTR and by amount and date within tolerance. Re-importing the same file creates no duplicate lines (hash index).
- **REC-03:** manual matching and exception resolution are audited, and the run counts update.

### 3.7 Registration and Providers
- **REG-01:** the full professional flow: OTP → profile → documents → plan → online payment → submit → approve → matchable.
- **REG-02:** the vendor flow, plus adding workers up to the cap. The (cap+1)th worker gets `WORKER_CAP_REACHED`. After an upgrade, adding succeeds. Concurrent adds at the cap never exceed it.
- **REG-03:** the same ID hash used by an active professional and a new worker → `PERSON_ALREADY_ACTIVE` and a conflict queue entry.
- **REG-04:** rejection follows the refund policy for FULL, PARTIAL and NONE.
- **REG-05:** an admin waiver needs `registration.waive` and is audited, and the provider can then be verified without a payment.
- **REG-06:** the provider type cannot change after payment (`PROVIDER_TYPE_LOCKED`).
- **REG-07:** editing a verified field after approval sets that field to pending re-verification without blocking unaffected skills (FR-PRO-06).

### 3.8 Auth, RBAC, IDOR
- **AUTH-01..08:**
  - OTP expiry, maximum attempts, resend cooldown and rate limit (429).
  - Lockout after repeated failures.
  - TOTP required for admins.
  - Refresh rotation.
  - Reuse of a refresh token revokes the token family.
  - Logout invalidates the session.
  - A changed `permVersion` takes effect immediately.
- **RBAC matrix test (generated):** for every route in the Swagger output, call it with each seeded role and assert the expected 2xx or 403 from a declarative matrix, `test/rbac-matrix.ts`. A new route without a matrix entry fails CI.
- **IDOR suite:** company A attempts to read or modify company B's enquiries, jobs, invoices, payments, attendance and documents, and gets 404 for each. Vendor A tries the same against vendor B's workers and invitations; a worker against another worker's assignments.
- **Injection:** `$`-prefixed keys in JSON bodies and query strings are rejected or stripped, and unknown keys are rejected (strict Zod).

### 3.9 Documents and Uploads
- **DOC-01:** a disallowed MIME type or an oversized file is rejected at the upload-intent step.
- **DOC-02:** an executable renamed `.pdf` is rejected after upload by the magic-byte check (`REJECTED_TYPE`) and the object is deleted.
- **DOC-03:** the EICAR test file gives `REJECTED_MALWARE`.
- **DOC-04:** a download URL is issued only to an authorised owner or admin, expires after about 60 seconds, and access to sensitive types is audited.
- **DOC-05:** expiry processing: the reminder event fires at the configured offsets, and on expiry `eligibility.isMatchable` becomes false and the provider drops out of matching.
- **DOC-06:** re-uploading a document supersedes the previous version, and the history is kept.

### 3.10 Execution
- **ATT-01:** check-in outside the geofence is flagged, not blocked.
- **ATT-02:** a duplicate check-in on the same day returns `ATTENDANCE_ALREADY_MARKED` (unique index).
- **ATT-03:** a proxy entry needs `attendance.proxy` and is tagged as proxy.
- **ATT-04:** a dispute auto-creates a complaint linked to the record.
- **ATT-05:** the no-show scheduled job fires after the grace period and notifies Ops and the vendor.
- **ATT-06:** an admin correction is audited with before and after values.
- **ATT-07:** the attendance summary feeds attendance-based invoice lines correctly.
- **CMP-01:** an SLA breach escalates the complaint and emits an event.
- **CMP-02:** a complaint resolved as `VALID` lowers the performance score on recompute.
- **CMP-03:** a company user never sees internal comments.

### 3.11 Notifications and Outbox
- **NTF-01:** an event produces one notification per channel per recipient. A duplicate event dispatch is deduplicated by a unique index.
- **NTF-02:** if WhatsApp fails, the SMS fallback is used, following the configured priority.
- **NTF-03:** a muted non-critical event is skipped, while critical events (OTP, assignment, payment) are always sent.
- **NTF-04:** quiet hours defer non-urgent messages.
- **OBX-01:** a transaction that aborts leaves no outbox event. A relay crash after publishing but before marking the event dispatched causes a redelivery, which the consumer deduplicates.

### 3.12 State Machines (unit, generated)
For each lifecycle, iterate over **all (state × event) pairs**. The lifecycles are provider, worker, document, enquiry, quotation, job, invitation, proposal, assignment, invoice, payment, cheque, refund and complaint. **v2 adds** work order, payroll run, advertiser, campaign and CMS page. Allowed pairs produce the expected next state; every other pair raises `INVALID_STATE_TRANSITION`. An integration sample checks that the persistence layer's conditional update returns 409 when the state is stale.

### 3.13 Technician registration and client booking (v2)
- **TEC-01:** submitting without all declarations returns `DECLARATION_MISSING`. A stale policy version returns `POLICY_VERSION_STALE`.
- **TEC-02:** `employeeNo` values are unique and sequential when 50 technicians submit concurrently.
- **TEC-03:** a zero-fee plan goes straight from `SUBMITTED` to `PENDING_VERIFICATION`, with no payment record.
- **CLR-01:** a revision request moves the quotation to `REVISION_REQUESTED`. The admin's revision supersedes it, and the client can accept only the latest version.
- **CLD-01 (IDOR):** client A gets 404 for client B's requirements, quotations, work orders, projects, assigned employees, attendance, invoices and payments.
- **WO-01:** allocation approval on a job whose work order is unsigned returns `WORK_ORDER_NOT_SIGNED` (BR-WO-01).

### 3.14 Payroll and billing separation (v2)
- **PAY-01:** two payroll runs over overlapping periods, fired concurrently. Each attendance day is paid exactly once (`payrollRunId` conditional), and the loser gets `ATTENDANCE_ALREADY_PAID` or `PAYROLL_PERIOD_OVERLAP`.
- **PAY-02:** payroll calculation inputs never contain `billRate`. A contract test on the read-model DTO enforces this, and changing billing rates leaves payroll totals unchanged (AC-10).
- **PAY-03:** the payroll preparer cannot approve their own run (`MAKER_CHECKER_VIOLATION`).
- **PAY-04:** vendor-worker lines are payable to the vendor, with a per-worker breakdown.
- **PAY-05:** table-driven unit tests for `computePayrollLine` cover half day, overtime, leave, allowances, deductions and rounding.

### 3.15 Advertising (v2)
- **ADV-01:** a campaign is never served unless it is `ACTIVE`. Test every other status, plus an unpaid but approved campaign, and confirm `/public/ads` returns 204 (BR-ADV-01).
- **ADV-02:** a browser-side "payment success" without a webhook leaves the campaign `PAYMENT_PENDING`. After a valid webhook it becomes `SCHEDULED`, and a duplicate webhook is a no-op.
- **ADV-03:** the scheduler activates the campaign at `startAt`, expires it at `endAt`, and sets `BUDGET_EXHAUSTED` when `spentPaise` reaches the budget. Inventory is released in each case. Tests use a fake clock.
- **ADV-04:** concurrent approvals for an exclusive slot over overlapping dates. Exactly one wins and the other gets `SLOT_EXCLUSIVE_CONFLICT`. Capacity is never exceeded.
- **ADV-05:** replaying an impression or click token counts once. Bot user agents and rate-limited IPs are recorded as `valid: false`. CPC and CPM spend is computed only from valid events, and it never exceeds the budget under concurrent roll-ups.
- **ADV-06:** a creative with the wrong dimensions, a spoofed MIME type or an `http:`, internal or blocklisted destination URL is rejected.
- **ADV-07:** targeting. A state- or city-targeted campaign is not served outside its locations, and device targeting is honoured.
- **ADV-08:** package prices come only from `ad_packages`. A test changes a price and confirms new campaigns use it while existing campaigns keep their snapshot.

### 3.16 Departments, geo scopes and CMS (v2)
- **SCP-01:** an HR admin scoped to Maharashtra sees only Maharashtra technicians and clients in lists, details (404 otherwise), reports and exports.
- **SCP-02:** removing a permission takes effect on the next request, with no re-login needed (`permVersion`).
- **SCP-03:** a role without `*.export` or `document.download` gets 403, even with broad read permissions.
- **CMS-01:** a draft edit is not visible publicly until publish. Publish increments the version and invalidates the cache.
- **CMS-02:** script tags, event handlers and `javascript:` URLs are stripped from rich text on save and on render.

---

## 3A. Acceptance Criteria Coverage (requirement document §16)
Each acceptance criterion in SRS §19.3 maps to at least one automated test and one UAT script:

| AC | Automated coverage |
|---|---|
| AC-01, AC-02 | E2E-01, E2E-09, TEC-01–03 |
| AC-03 – AC-06 | E2E-03, CLR-01, WO-01 |
| AC-07, AC-08 | E2E-04, ALC suite (3.1) |
| AC-09 | E2E-05, 3.10 |
| AC-10, AC-11 | PAY-01–05, E2E-05, E2E-10 |
| AC-12 – AC-18 | ADV-01–08, E2E-11 |
| AC-19, AC-20 | SCP-01–03, 3.8 |
| AC-21 | Dashboard smoke tests assert data comes from the API (no static fixtures in production builds) |
| AC-22 | All E2E journeys at 360 px and desktop |

---

## 4. End-to-End Journeys (Playwright)
| ID | Journey | Portals |
|---|---|---|
| E2E-01 | Professional onboarding → Razorpay (fake checkout) → admin verification → approved | Provider (mobile viewport), Admin |
| E2E-02 | Vendor onboarding → add 3 workers → offline registration payment → finance verifies → verifier approves vendor and workers | Provider, Admin |
| E2E-03 | Public enquiry → lead converted → quotation built → company accepts → job created | Public, Admin, Company |
| E2E-04 | **Allocation:** run matching → invite 3 professionals and 1 vendor → responses (1 declined) → admin builds proposal → submit → second admin approves → assignments visible to provider, worker and company → notifications in the inbox | Admin ×2, Provider, Company |
| E2E-05 | Check-in and check-out (mocked geolocation) → company confirms → attendance invoice → company pays online → invoice PAID | Provider, Company, Admin |
| E2E-06 | Offline business payment with proof → maker-checker verify → partial refund → reconciliation run shows the match | Company, Admin |
| E2E-07 | Complaint raised by the company → support resolves → provider score updated | Company, Admin |
| E2E-08 | Replacement of an assigned worker | Admin, Provider |
| E2E-09 | **v2:** technician completes the six-step wizard on a phone → Employee ID shown → HR requests documents → technician re-uploads → approved | Public, Provider (mobile), Admin |
| E2E-10 | **v2:** approved attendance → payroll run → second admin approves → mark paid → payslip visible to the employee; client invoice for the same period is generated independently | Admin ×2, Provider, Company |
| E2E-11 | **v2:** advertiser registers → admin approves → campaign wizard → admin approves → Razorpay fake checkout + webhook → campaign scheduled → goes live on the targeted page → impressions and clicks appear in analytics → campaign expires | Public, Advertiser, Admin |
| E2E-12 | **v2:** Super Admin creates a city-scoped HR role, assigns it, and the user sees only that city's data | Admin ×2 |
| E2E-13 | **v2:** CMS page edited, previewed and published → public page and sitemap updated | Admin, Public |

Each journey also runs at a 360 px viewport for its provider and company steps, with an axe accessibility scan on every page visited.

---

## 5. Non-Functional Tests
| ID | Target (SRS §10) | Method |
|---|---|---|
| NFR-P01 | Read p95 < 300 ms, write p95 < 600 ms at 100 virtual users | k6 mixed scenario for 15 minutes against staging-sized data |
| NFR-P02 | Match run over 50,000 providers < 3 s | k6 plus timing assertions in a seeded perf environment, with `explain()` checked for index use |
| NFR-P03 | Approving a 50-line proposal < 2 s | k6 single-request timing |
| NFR-P04 | Webhook ingress p99 < 200 ms under 50 requests per second | k6 |
| NFR-S01 | OWASP ZAP baseline with no high findings | ZAP in CI before each release |
| NFR-S02 | No critical or high CVEs in dependencies or images | `pnpm audit`, Trivy |
| NFR-S03 | Log redaction | An integration test greps the captured logs for a seeded OTP, PAN or bank number and expects no match |
| NFR-A01 | WCAG 2.1 AA | axe with zero serious or critical violations, plus a manual keyboard pass |
| NFR-R01 | Backup and restore | Point-in-time restore drill before go-live, with RPO and RTO checked |
| NFR-R02 | Transaction retry | Inject `TransientTransactionError` and confirm one retry and correct final state |

---

## 6. Traceability Matrix (excerpt; the full matrix is maintained in `test/traceability.md` and updated per module)
| Requirement | Tests |
|---|---|
| FR-AUTH-04/05 | AUTH-01..05 |
| FR-USR-04 | RBAC matrix, IDOR suite |
| FR-VWK-04 / BR-PRV-01 | REG-03 |
| FR-REG-03 / BR-REG-02 | REG-02 |
| FR-REG-05 | REG-04 |
| FR-DOC-02/03 | DOC-01..04 |
| FR-DOC-06 | DOC-05 |
| FR-MAT-02/03/05 | MAT-01..04 |
| FR-INV-07 | INV-02..05 |
| FR-INV-08 / BR-ALC-02 | INV-01, INV-09 |
| FR-ALC-04 | ALC-C01, C02, C05, C07, C09, C14 |
| FR-ALC-06/07 | ALC-C03, C04, C06, C13 |
| BR-ALC-04 | ALC-C02, §3.4 overlap suite |
| BR-ALC-05 | ALC-C01, C13 |
| BR-ALC-06 | ALC-C07, C08 |
| BR-ALC-07 | ALC-C10 |
| FR-ASG-04 | ALC-C12, E2E-08 |
| FR-ATT-01..07 | ATT-01..07 |
| FR-INVC-02 | PAY-16 |
| FR-QUO-06 / FR-INVC-03 | PAY-17 |
| FR-BPAY-01 / FR-WHK-01..05 | PAY-01..07, PAY-15 |
| FR-BPAY-03 / BR-FIN-03 | PAY-08, PAY-13 |
| FR-BPAY-07 | PAY-09 |
| FR-BPAY-09 | PAY-14 |
| FR-RFD-04 | PAY-12 |
| FR-REC-01..03 | REC-01..03 |
| FR-NTF-02..06 | NTF-01..04 |
| FR-CMPL-02/04 | CMP-01, CMP-02 |
| NFR-PERF-01..04 | NFR-P01..P03 |

---

## 7. CI Pipeline Gates
1. Install with a cached pnpm store.
2. Lint, typecheck and boundary rules.
3. Unit tests for API and web, with the coverage gates in §2.2.
4. Integration tests (sharded by module, with replica set, Redis and MinIO services).
5. Contract diff on pull requests.
6. Build the images and run a Trivy scan.
7. E2E smoke tests (E2E-01 and E2E-04) on pull requests to `main`; the full E2E suite nightly.

A pull request can merge only when steps 1–6 are green.

## 8. Defect Severity and Exit Criteria
- **S1** (data integrity, financial, security): blocks the release, with no exceptions.
- **S2** (a core flow is broken but has a workaround): must be fixed before UAT sign-off.
- **S3 and S4**: triaged into the backlog.
- **Release exit criteria:**
  - All S1 and S2 defects closed.
  - All ALC-C*, PAY-* and security suites green.
  - NFR targets met.
  - UAT signed off by the Ops, Finance and Verification roles.
