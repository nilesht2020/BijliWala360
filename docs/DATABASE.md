# Bijli Wala — Database Design (MongoDB)

| Field | Value |
|---|---|
| Version | 0.3 (Phase 4 collections implemented; v2 collections designed in §15) |
| Date | 2026-11-18 |
| Source | `SRS.md` v2.0, `ARCHITECTURE.md` v0.2, `bijli wala .docx` §11 |

---

## 1. Conventions

| Topic | Convention |
|---|---|
| Deployment | A replica set is **mandatory**, because transactions are used. Dev uses a single-node `rs0`. |
| Naming | Collections use `snake_case` plural names. Fields use `camelCase`. |
| IDs | `_id: ObjectId`. Human-readable numbers (`jobNo`, `invoiceNo` and others) come from the `counters` collection. |
| Timestamps | Every collection has `createdAt` and `updatedAt` (Mongoose `timestamps`), plus `createdBy` and `updatedBy` (`ObjectId` of a user) where a user acts. |
| Optimistic concurrency | Mutable aggregates have a `version: number` field. Updates filter on `version` and `$inc` it. |
| Money | **Integer paise** (`amountPaise: number`, a safe integer) plus `currency: 'INR'`. Floating-point numbers are never used for money. |
| Calendar dates | `'YYYY-MM-DD'` strings in the site's time zone, for schedules and attendance days. |
| Instants | `Date` (UTC). |
| Shift time | `startMin` and `endMin` (0–1439) in minutes from local midnight. `endMin <= startMin` means the shift crosses midnight. |
| Geo | GeoJSON `{ type: 'Point', coordinates: [lng, lat] }` with a `2dsphere` index. |
| Encrypted PII | `{ ct, iv, tag, kv }` (AES-256-GCM ciphertext and key version) plus a separate `*Hash` field (HMAC-SHA256) for lookup, and `*Last4` for display. |
| Soft delete | Financial and audit records are never deleted (BR-FIN-04). Master data uses `isActive` or `status`. |
| Status enums | Defined in `packages/contracts/enums`. They are listed with each collection below. |
| Index creation | Through `migrate-mongo` migrations. Production runs with `autoIndex: false`. |

Index notation: `{a:1, b:-1}`. U = unique, P = partial (`partialFilterExpression`), TTL = expiring, S = sparse.

---

## 2. Collection Map by Module

| Module | Collections |
|---|---|
| Core | `counters`, `idempotency_keys`, `outbox_events`, `processed_events`, `business_settings`, `webhook_events`, `ledger_entries` |
| Auth | `otp_challenges`, `refresh_tokens` |
| Users | `users`, `roles`, `role_assignments` |
| Audit | `audit_logs` |
| Person Registry | `persons` |
| Service Categories | `service_categories`, `skills` |
| Documents | `document_types`, `documents` |
| Registration Plans | `registration_plans` |
| Professionals | `professionals` |
| Vendors | `vendors` |
| Vendor Workers | `vendor_workers` |
| Registration Payments | `provider_registrations`, `registration_payments`, `registration_refunds` |
| Companies | `companies`, `company_sites` |
| Enquiries | `enquiries` |
| Quotations | `quotations` |
| Jobs | `jobs` |
| Matching | `match_runs` |
| Invitations | `invitations` |
| Allocation Proposals | `allocation_proposals` |
| Assignments | `assignments`, `commitments`, `assignment_change_requests` |
| Attendance | `attendance_records` |
| Complaints | `complaints` |
| Ratings & Performance | `ratings`, `performance_snapshots` |
| Invoices | `invoices`, `credit_notes` |
| Business Payments | `business_payments`, `payment_allocations`, `business_refunds` |
| Reconciliation | `reconciliation_runs`, `reconciliation_items`, `bank_statement_lines` |
| Notifications | `notification_templates`, `notifications`, `notification_preferences` |
| Reports | `report_exports` |

---

## 3. Core Collections

### `counters`
```ts
{ _id: string /* e.g. 'job', 'invoice:2026-27', 'creditNote:2026-27', 'quotation' */, seq: number }
```
`next(name, session)` runs `findOneAndUpdate({_id}, {$inc:{seq:1}}, {upsert:true, new:true, session})`. Because the counter is incremented inside the business transaction, a rollback also rolls back the number, which keeps invoice numbers gap-free.

### `idempotency_keys`
```ts
{ key: string, userId: ObjectId, route: string /* 'POST /api/v1/allocation-proposals/:id/approve' */,
  requestHash: string, status: 'IN_PROGRESS'|'COMPLETED', httpStatus?: number, responseBody?: unknown,
  expiresAt: Date }
```
Indexes: U `{key:1, userId:1, route:1}`; TTL `{expiresAt:1}` (expires after 0 seconds, with `expiresAt` set 24 hours ahead).

### `outbox_events`
```ts
{ eventId: string /* uuid */, type: string /* 'allocation.approved' */, aggregateType: string, aggregateId: ObjectId,
  payload: object, status: 'PENDING'|'DISPATCHED'|'FAILED', attempts: number,
  leaseUntil?: Date, dispatchedAt?: Date, lastError?: string }
```
Indexes: U `{eventId:1}`; `{status:1, leaseUntil:1, createdAt:1}`; TTL `{dispatchedAt:1}` (30 days).

### `processed_events`
Consumer idempotency: `{ consumer: string, eventId: string, processedAt }`. Indexes: U `{consumer:1, eventId:1}`; TTL 30 days.

### `business_settings`
```ts
{ key: string /* 'matching.weights' */, value: unknown /* validated by the contract registry */, version: number,
  updatedBy: ObjectId, history: [{ value, version, updatedBy, updatedAt }] /* history capped at the last 50 */ }
```
Indexes: U `{key:1}`.

### `webhook_events`
```ts
{ provider: 'RAZORPAY'|'WHATSAPP'|'SMS', eventId: string, eventType: string, signatureValid: boolean,
  payload: object, receivedAt: Date, status: 'RECEIVED'|'PROCESSED'|'IGNORED'|'FAILED',
  domain?: 'REGISTRATION'|'BUSINESS', processedAt?: Date, error?: string, attempts: number }
```
Indexes: U `{provider:1, eventId:1}`; `{status:1, receivedAt:1}`; `{'payload.payload.payment.entity.id':1}` S (for lookup during reconciliation).

### `ledger_entries` (append-only)
```ts
{ journalId: string /* groups balanced lines */, book: 'REGISTRATION'|'BUSINESS',
  account: 'GATEWAY_CLEARING'|'BANK'|'ACCOUNTS_RECEIVABLE'|'REGISTRATION_REVENUE'|'SERVICE_REVENUE'
         |'GST_OUTPUT'|'REFUND_PAYABLE'|'UNAPPLIED_CASH'|'WAIVER_EXPENSE',
  debitPaise: number, creditPaise: number, currency: 'INR',
  refType: 'REGISTRATION_PAYMENT'|'BUSINESS_PAYMENT'|'INVOICE'|'CREDIT_NOTE'|'REFUND',
  refId: ObjectId, partyType?: 'COMPANY'|'PROFESSIONAL'|'VENDOR', partyId?: ObjectId,
  narration: string, postedAt: Date, postedBy?: ObjectId, reversesJournalId?: string }
```
Indexes: `{journalId:1}`; `{book:1, account:1, postedAt:1}`; `{refType:1, refId:1}`; `{partyType:1, partyId:1, postedAt:1}`.
Invariant: for each `journalId`, the sum of debits equals the sum of credits. This is checked in the ledger service before insert. The repository exposes no update or delete operations.

---

## 4. Identity and Access

### `users`
```ts
{ mobile?: string /* E.164 */, mobileVerifiedAt?: Date, email?: string /* lowercased */, emailVerifiedAt?: Date,
  name: string, passwordHash?: string, mfa?: { enabled: boolean, secretEnc: Enc, enrolledAt: Date },
  userType: 'ADMIN'|'COMPANY'|'PROFESSIONAL'|'VENDOR'|'VENDOR_WORKER',
  status: 'ACTIVE'|'SUSPENDED'|'DEACTIVATED',
  passwordReset?: { tokenHash: string /* sha256 */, expiresAt: Date },
  mfa?: { enabled: boolean, secretEnc?: Enc, pendingSecretEnc?: Enc, lastUsedStep?: number /* TOTP replay guard */, enrolledAt?: Date },
  failedLoginCount: number, lockedUntil?: Date, lastLoginAt?: Date,
  permVersion: number, consent: { termsVersion: string, acceptedAt: Date, ip: string }[], version: number }
```
Indexes: U P `{mobile:1}` (mobile exists); U P `{email:1}` (email exists); `{userType:1, status:1}`.

### `roles`
```ts
{ code: string /* 'OPS_ADMIN' */, name: string, description?: string,
  scopeType: 'PLATFORM'|'COMPANY'|'VENDOR', permissions: string[], isSystem: boolean, version: number }
```
Indexes: U `{code:1}`.

### `role_assignments`
```ts
{ userId: ObjectId, roleId: ObjectId, roleCode: string,
  scope: { type: 'PLATFORM' } | { type: 'COMPANY', companyId: ObjectId, siteIds?: ObjectId[] } | { type: 'VENDOR', vendorId: ObjectId },
  scopeKey: 'PLATFORM' | 'COMPANY:<id>' | 'VENDOR:<id>', grantedBy: string,
  active: boolean /* false once revoked */, revokedAt?: Date, revokedBy?: string }
```
Indexes: `{userId:1, active:1}`; `{roleId:1, active:1}`; `{roleCode:1, active:1}`; `{'scope.companyId':1}` S; `{'scope.vendorId':1}` S; U P `{userId:1, roleId:1, scopeKey:1}` (where `active: true`).
> MongoDB partial indexes cannot filter on `$exists: false`. Every unique index in this document that applies only while a record is active therefore filters on an explicit boolean or status field instead.

### `otp_challenges`
```ts
{ mobile: string, purpose: 'LOGIN', codeHash: string /* HMAC(pepper, mobile:code) */, attempts: number,
  maxAttempts: number, expiresAt: Date, consumedAt?: Date, supersededAt?: Date /* a newer code was sent */, ip: string }
```
Indexes: `{mobile:1, createdAt:-1}`; `{ip:1, createdAt:-1}`; TTL `{expiresAt:1}` (expires 1 hour after `expiresAt`).

### `refresh_tokens`
```ts
{ userId: ObjectId, familyId: string, tokenHash: string, parentHash?: string, expiresAt: Date,
  revokedAt?: Date, revokedReason?: 'ROTATED'|'LOGOUT'|'REUSE_DETECTED'|'ADMIN', userAgent: string, ip: string }
```
Indexes: U `{tokenHash:1}`; `{userId:1, familyId:1}`; TTL `{expiresAt:1}`.

### `audit_logs` (append-only)
```ts
{ at: Date, actor: { userId?: ObjectId, userType?: string, roleCodes?: string[], system?: string },
  action: string /* 'allocation.approve' */, entityType: string, entityId: ObjectId|string,
  before?: object, after?: object, diff?: object /* redacted */, reason?: string,
  requestId?: string, ip?: string, userAgent?: string, isFinancial: boolean, expireAt?: Date }
```
Indexes: `{entityType:1, entityId:1, at:-1}`; `{'actor.userId':1, at:-1}`; `{action:1, at:-1}`; TTL `{expireAt:1}`. `expireAt` is set only on non-financial entries (7 years). Financial entries never expire.

---

## 5. Providers

### `persons` (Person Registry)
```ts
{ fullName: string, idType?: 'AADHAAR'|'PAN'|'VOTER_ID'|'DL'|'PASSPORT', idHash?: string, idLast4?: string,
  mobileHash?: string, activeRole?: { type: 'PROFESSIONAL', professionalId: ObjectId }
                                    | { type: 'VENDOR_WORKER', vendorId: ObjectId, workerId: ObjectId },
  isActive: boolean, scheduleVersion: number /* write-lock counter (ARCH §6.3) */,
  conflicts?: { detectedAt: Date, withPersonId: ObjectId, status: 'OPEN'|'RESOLVED', note?: string }[] }
```
Indexes: U P `{idHash:1}` (where `isActive:true` and `idHash` exists); U P `{mobileHash:1}` (where `isActive:true` and `mobileHash` exists); `{'conflicts.status':1}` S.

### `professionals`
```ts
{ userId: ObjectId, personId: ObjectId, fullName: string, photoDocId?: ObjectId, dob?: string, gender?: string,
  address: Address, serviceLocation: GeoPoint, radiusKm: number, languages: string[], experienceYears: number,
  categoryIds: ObjectId[], skills: { skillId: ObjectId, proficiency: 'BEGINNER'|'INTERMEDIATE'|'EXPERT', years: number,
            verification: 'PENDING'|'VERIFIED'|'REJECTED' }[],
  certifications: { name: string, docId: ObjectId, expiresOn?: string }[],
  bank?: { accountEnc: Enc, accountLast4: string, ifsc: string, holderName: string },
  availability: { weekly: { dow: 0|1|2|3|4|5|6, startMin: number, endMin: number }[], blockedDates: string[] },
  status: 'DRAFT'|'PENDING_PAYMENT'|'PENDING_VERIFICATION'|'CHANGES_REQUESTED'|'APPROVED'|'REJECTED'|'SUSPENDED'|'DEACTIVATED',
  completionPct: number,
  eligibility: { isMatchable: boolean, verifiedSkillIds: ObjectId[], docsValidUntil?: string, reasons: string[] },
  performance: { score: number, ratingAvg: number, ratingCount: number, attendanceRate: number, noShowCount: number },
  approvedAt?: Date, approvedBy?: ObjectId, version: number }
```
`eligibility` is a denormalised read model. It is recomputed whenever status, documents or skills change, and is used by matching.

Indexes: U `{userId:1}`; U `{personId:1}`; `{serviceLocation:'2dsphere'}`; `{status:1, 'eligibility.isMatchable':1, 'eligibility.verifiedSkillIds':1}`; `{categoryIds:1}`; `{status:1, createdAt:-1}` (verification queue).

### `vendors`
```ts
{ legalName: string, tradeName?: string, entityType: 'PROPRIETORSHIP'|'PARTNERSHIP'|'LLP'|'PVT_LTD'|'PUBLIC_LTD'|'OTHER',
  gstin?: string, panEnc: Enc, panHash: string, panLast4: string, registeredAddress: Address,
  operatingLocations: { label: string, point: GeoPoint, radiusKm: number }[], categoryIds: ObjectId[],
  contacts: { name: string, mobile: string, email?: string, designation?: string }[],
  bank?: { accountEnc: Enc, accountLast4: string, ifsc: string, holderName: string },
  status: /* same lifecycle as professionals */ string, completionPct: number,
  workerCap: number | null /* from plan snapshot */, activeWorkerCount: number,
  eligibility: { isMatchable: boolean, reasons: string[] },
  performance: { score: number, ratingAvg: number, ratingCount: number },
  approvedAt?: Date, approvedBy?: ObjectId, version: number }
```
Indexes: U P `{gstin:1}` (gstin exists); U `{panHash:1}`; `{'operatingLocations.point':'2dsphere'}`; `{status:1, createdAt:-1}`.
The worker-cap guard is a conditional update: `updateOne({_id, $or:[{workerCap:null},{$expr:{$lt:['$activeWorkerCount','$workerCap']}}]}, {$inc:{activeWorkerCount:1}})`.

### `vendor_workers`
```ts
{ vendorId: ObjectId, personId: ObjectId, userId?: ObjectId, fullName: string, mobile?: string, photoDocId?: ObjectId,
  baseLocation: GeoPoint, experienceYears: number,
  skills: { skillId: ObjectId, proficiency: string, years: number, verification: 'PENDING'|'VERIFIED'|'REJECTED' }[],
  certifications: { name: string, docId: ObjectId, expiresOn?: string }[],
  availability: { weekly: WeeklySlot[], blockedDates: string[] },
  status: 'PENDING_VERIFICATION'|'ACTIVE'|'REJECTED'|'INACTIVE',
  eligibility: { isMatchable: boolean, verifiedSkillIds: ObjectId[], docsValidUntil?: string, reasons: string[] },
  performance: { score: number, ratingAvg: number, ratingCount: number, attendanceRate: number, noShowCount: number },
  version: number }
```
Indexes: `{vendorId:1, status:1}`; U `{personId:1}` P (status in `PENDING_VERIFICATION`, `ACTIVE`); `{baseLocation:'2dsphere'}`; `{vendorId:1, 'eligibility.isMatchable':1, 'eligibility.verifiedSkillIds':1}`; U P `{userId:1}` (userId exists).

---

## 6. Catalogue, Documents, Plans

### `service_categories`
```ts
{ name: string, slug: string, parentId: ObjectId|null, ancestors: ObjectId[], level: 1|2|3, description?: string,
  imageDocId?: ObjectId, imageUrl?: string /* public CDN for catalogue images */, icon?: string,
  displayOrder: number, isActive: boolean, seo?: { title?: string, description?: string } }
```
Indexes: U `{slug:1}`; `{parentId:1, displayOrder:1}`; `{ancestors:1}`; `{isActive:1, level:1}`; text `{name:'text', description:'text'}`.

### `skills`
```ts
{ code: string, name: string, categoryIds: ObjectId[], requiredDocTypeCodes: string[], sacCode?: string, isActive: boolean }
```
Indexes: U `{code:1}`; `{categoryIds:1}`; text `{name:'text'}`.

### `document_types`
```ts
{ code: string /* 'PAN','AADHAAR_MASKED','GST_CERT','ELEC_LICENSE','POLICE_VERIF','CANCELLED_CHEQUE','ATTENDANCE_SELFIE','PAYMENT_PROOF','BANK_STATEMENT' */,
  name: string, ownerTypes: ('PROFESSIONAL'|'VENDOR'|'VENDOR_WORKER'|'COMPANY'|'PAYMENT'|'ENQUIRY'|'COMPLAINT'|'ATTENDANCE'|'RECONCILIATION'|'CATEGORY')[],
  allowedMime: string[], maxSizeBytes: number, hasExpiry: boolean, captureNumber: boolean,
  numberPattern?: string, isSensitive: boolean, reminderDaysBefore?: number[], isActive: boolean }
```
Indexes: U `{code:1}`.

### `documents`
```ts
{ typeCode: string, owner: { type: OwnerType, id: ObjectId }, uploadedBy: ObjectId,
  fileName: string, mime: string, sizeBytes: number, storageKey: string /* quarantine/ or clean/ */, sha256?: string,
  numberEnc?: Enc, numberHash?: string, numberLast4?: string, expiresOn?: string,
  status: 'PENDING_UPLOAD'|'SCANNING'|'UPLOADED'|'VERIFIED'|'REJECTED'|'REJECTED_MALWARE'|'REJECTED_TYPE'|'EXPIRED'|'SUPERSEDED',
  versionNo: number, previousDocId?: ObjectId,
  review?: { by: ObjectId, at: Date, decision: 'VERIFIED'|'REJECTED', comment?: string },
  uploadIntentExpiresAt: Date }
```
Indexes: `{'owner.type':1, 'owner.id':1, typeCode:1, status:1}`; `{status:1, expiresOn:1}` (expiry scheduled job); `{numberHash:1}` S (duplicate detection); `{status:1, uploadIntentExpiresAt:1}` (clean-up of abandoned intents).

### `registration_plans`
```ts
{ code: string, name: string, providerType: 'PROFESSIONAL'|'VENDOR', feePaise: number, gstRateBp: number /* basis points: 1800 = 18% */,
  sacCode: string, features: string[], maxWorkers: number|null, mandatoryDocTypeCodes: string[],
  gstinRequired: boolean, offlinePaymentAllowed: boolean,
  refundPolicy: { onRejection: 'FULL'|'PARTIAL'|'NONE', partialPct?: number },
  validity: 'ONE_TIME', effectiveFrom: Date, effectiveTo?: Date, isActive: boolean, displayOrder: number, version: number }
```
Indexes: U `{code:1}`; `{providerType:1, isActive:1, displayOrder:1}`.

---

## 7. Registration

### `provider_registrations`
One document per provider. It holds the workflow record and the plan snapshot.
```ts
{ providerType: 'PROFESSIONAL'|'VENDOR', providerId: ObjectId, userId: ObjectId,
  planSnapshot: { planId, code, name, feePaise, gstRateBp, maxWorkers, refundPolicy, mandatoryDocTypeCodes, offlinePaymentAllowed },
  upgrades: { fromPlanCode: string, toPlanSnapshot: object, paymentId: ObjectId, at: Date }[],
  payment: { status: 'UNPAID'|'PENDING'|'PAID'|'WAIVED'|'REFUNDED'|'PARTIALLY_REFUNDED',
             totalPaise: number, paidPaise: number, waiver?: { by: ObjectId, reason: string, amountPaise: number, at: Date } },
  verification: { status: 'NOT_SUBMITTED'|'PENDING'|'CHANGES_REQUESTED'|'APPROVED'|'REJECTED',
                  submittedAt?: Date, assignedTo?: ObjectId,
                  checklist: { item: string /* doc code or field path */, result: 'OK'|'ISSUE'|'PENDING', comment?: string }[],
                  decisions: { decision: 'APPROVED'|'REJECTED'|'CHANGES_REQUESTED', by: ObjectId, at: Date, reason?: string, checklistSnapshot: object }[] },
  version: number }
```
Indexes: U `{providerType:1, providerId:1}`; `{'verification.status':1, 'verification.submittedAt':1}`; `{'payment.status':1}`.

### `registration_payments`
```ts
{ registrationId: ObjectId, providerType, providerId, purpose: 'REGISTRATION'|'UPGRADE',
  mode: 'ONLINE'|'OFFLINE', method?: 'BANK_TRANSFER'|'CHEQUE'|'UPI_DIRECT'|'CASH'|'OTHER',
  basePaise: number, taxPaise: number, amountPaise: number, currency: 'INR',
  gateway?: { orderId: string, paymentId?: string, signatureVerifiedAt?: Date, method?: string, fee?: number, tax?: number },
  offline?: { reference: string, bank?: string, paidOn: string, proofDocId: ObjectId, chequeStatus?: 'RECEIVED'|'DEPOSITED'|'CLEARED'|'BOUNCED' },
  status: 'CREATED'|'PENDING_CONFIRMATION'|'PENDING_VERIFICATION'|'SUCCESS'|'FAILED'|'REJECTED'|'PARTIALLY_REFUNDED'|'REFUNDED',
  capturedPaise: number, refundedPaise: number,
  recordedBy?: ObjectId, verifiedBy?: ObjectId, verifiedAt?: Date, rejectionReason?: string,
  receiptNo?: string, failureReason?: string, version: number }
```
Indexes: `{registrationId:1, createdAt:-1}`; U P `{'gateway.orderId':1}`; U P `{'gateway.paymentId':1}`; U P `{mode:1, method:1, 'offline.reference':1, 'offline.bank':1}` (offline only; status not in `REJECTED`, `FAILED`); `{status:1, createdAt:1}` (sweeper).

### `registration_refunds`
```ts
{ paymentId: ObjectId, amountPaise: number, reason: string, mode: 'ONLINE'|'OFFLINE',
  status: 'PENDING_APPROVAL'|'APPROVED'|'PROCESSING'|'PROCESSED'|'FAILED'|'REJECTED',
  gatewayRefundId?: string, offline?: { reference: string, proofDocId: ObjectId },
  requestedBy: ObjectId, approvedBy?: ObjectId, processedAt?: Date, failureReason?: string, version: number }
```
Indexes: `{paymentId:1}`; U P `{gatewayRefundId:1}`; `{status:1}`.

---

## 8. Demand Side

### `companies`
```ts
{ legalName: string, gstin?: string, panEnc?: Enc, panHash?: string, billingAddress: Address & { stateCode: string },
  industry?: string, size?: string, primaryContactUserId: ObjectId,
  status: 'PENDING_VERIFICATION'|'ACTIVE'|'SUSPENDED',
  commercialTerms: { creditDays: number, creditLimitPaise?: number, offlinePaymentAllowed: boolean, advancePct: number },
  blockedProviders: { type: 'PROFESSIONAL'|'VENDOR'|'VENDOR_WORKER', id: ObjectId, reason?: string }[],
  activatedBy?: ObjectId, activatedAt?: Date, version: number }
```
Indexes: U P `{gstin:1}`; `{status:1, createdAt:-1}`; text `{legalName:'text'}`.

### `company_sites`
```ts
{ companyId: ObjectId, name: string, address: Address & { stateCode: string }, location: GeoPoint, timezone: string /* 'Asia/Kolkata' */,
  contact: { name: string, mobile: string }, geofenceMeters?: number /* overrides config */, isActive: boolean }
```
Indexes: `{companyId:1, isActive:1}`; `{location:'2dsphere'}`.

### `enquiries`
```ts
{ enquiryNo: string, source: 'COMPANY'|'PUBLIC_LEAD'|'ADMIN', companyId?: ObjectId,
  lead?: { name: string, companyName: string, mobile: string, email?: string, city: string },
  categoryId: ObjectId, siteId?: ObjectId,
  lines: { skillId: ObjectId, headcount: number, minExperienceYears?: number, notes?: string }[],
  schedule: { startDate: string, endDate?: string, durationDays?: number, weekdays: number[], shift: { startMin: number, endMin: number } },
  description: string, attachmentDocIds: ObjectId[], budgetPaise?: number,
  status: 'NEW'|'IN_REVIEW'|'QUOTED'|'ACCEPTED'|'REJECTED'|'EXPIRED'|'CANCELLED',
  assignedTo?: ObjectId, notes: { by: ObjectId, at: Date, text: string }[], version: number }
```
Indexes: U `{enquiryNo:1}`; `{companyId:1, createdAt:-1}`; `{status:1, assignedTo:1, createdAt:-1}`.

### `quotations`
```ts
{ quotationNo: string, version: number /* document revision number */, enquiryId: ObjectId, companyId: ObjectId, siteId: ObjectId,
  lines: { lineId: string, skillId: ObjectId, description: string, headcount: number,
           unit: 'HOUR'|'DAY'|'MONTH'|'FIXED', ratePaise: number, quantity: number /* units per head */,
           payRatePaise?: number /* internal, provider-facing */, sacCode: string, gstRateBp: number,
           amountPaise: number, taxPaise: number }[],
  discountPaise: number, subtotalPaise: number,
  tax: { type: 'INTRA'|'INTER', cgstPaise: number, sgstPaise: number, igstPaise: number }, totalPaise: number,
  schedule: { startDate, endDate, weekdays, shift },
  paymentTerms: { advancePct: number, milestones: { label: string, pct: number, due: 'ON_ACCEPT'|'ON_START'|'ON_COMPLETION'|'DATE', dueDate?: string }[] },
  terms: string, validUntil: string,
  pdf?: { key: string, rev: number, generatedAt: Date } /* Phase 4: private object under exports/, not a documents record */,
  isLatest: boolean /* partial unique {enquiryId} where isLatest */, supplierStateCode: string, placeOfSupplyStateCode: string,
  billingAddress: Address /* snapshot */,
  status: 'DRAFT'|'SENT'|'ACCEPTED'|'REJECTED'|'EXPIRED'|'SUPERSEDED',
  sentAt?: Date, decision?: { by: ObjectId, at: Date, ip: string, reason?: string },
  supersedesId?: ObjectId, jobId?: ObjectId, rev: number /* optimistic lock */ }
```
Indexes: U `{quotationNo:1, version:1}`; `{enquiryId:1, version:-1}`; `{companyId:1, status:1}`; `{status:1, validUntil:1}`.

---

## 9. Jobs and Allocation

### `jobs`
```ts
{ jobNo: string, companyId: ObjectId, siteId: ObjectId, categoryId: ObjectId, quotationId?: ObjectId,
  title: string, description?: string, instructions?: string,
  schedule: { startDate: string, endDate: string, weekdays: number[], excludedDates: string[], timezone: string },
  positions: {
    _id: ObjectId, skillId: ObjectId, title: string, minExperienceYears: number, requiredCertDocTypeCodes: string[],
    shift: { startMin: number, endMin: number },
    required: number, held: number, confirmed: number, available: number /* = required - held - confirmed */,
    billRatePaise: number, billUnit: 'HOUR'|'DAY'|'MONTH'|'FIXED', payRatePaise?: number, showPayRate: boolean,
    allowPartialAvailability: boolean }[],
  billingBasis: 'MILESTONE'|'ATTENDANCE',
  status: 'DRAFT'|'OPEN'|'MATCHING'|'ALLOCATING'|'PARTIALLY_STAFFED'|'STAFFED'|'IN_PROGRESS'|'COMPLETED'|'ON_HOLD'|'CANCELLED',
  statusHistory: { from: string, to: string, by?: ObjectId, at: Date, reason?: string }[],
  cancellation?: { by: ObjectId, at: Date, reason: string }, version: number }
```
Indexes: U `{jobNo:1}`; `{companyId:1, status:1, 'schedule.startDate':-1}`; `{status:1, 'schedule.startDate':1}`; `{'positions._id':1}`.
Position reservation (ARCH §6.3):
```js
updateOne({ _id: jobId, positions: { $elemMatch: { _id: posId, available: { $gte: n } } } },
          { $inc: { 'positions.$.held': n, 'positions.$.available': -n }, $set: { updatedAt: now } }, { session })
```

### `match_runs`
```ts
{ jobId: ObjectId, positionId: ObjectId, runBy: ObjectId, runAt: Date,
  inputs: { skillId, siteLocation, schedule, shift, minExperienceYears, requiredCertDocTypeCodes, maxRadiusKm },
  weights: { version: number, values: Record<string, number> },
  candidates: { kind: 'PROFESSIONAL'|'VENDOR', providerId: ObjectId, personId?: ObjectId,
                eligibleWorkerCount?: number, topWorkerIds?: ObjectId[], distanceKm: number,
                score: number, breakdown: Record<string, number>, rank: number }[],
  excluded: { providerId: ObjectId, kind: string, reasons: string[] }[],  // capped at 500 entries; the count is stored separately
  excludedCount: number,
  overrides: { providerId: ObjectId, kind: string, overriddenRule: string, justification: string, by: ObjectId, at: Date }[],
  durationMs: number }
```
Indexes: `{jobId:1, positionId:1, runAt:-1}`.

### `invitations`
```ts
{ jobId: ObjectId, positionId: ObjectId, matchRunId: ObjectId,
  recipient: { kind: 'PROFESSIONAL', professionalId: ObjectId, personId: ObjectId, userId: ObjectId }
           | { kind: 'VENDOR', vendorId: ObjectId, userIds: ObjectId[] },
  offer: { payRatePaise?: number, shift, startDate, endDate, areaLabel: string },
  deadlineAt: Date, status: 'SENT'|'VIEWED'|'RESPONDED_INTERESTED'|'RESPONDED_DECLINED'|'EXPIRED'|'WITHDRAWN',
  viewedAt?: Date, sentBy: ObjectId, withdrawnBy?: ObjectId, withdrawReason?: string,
  responses: { responseVersion: number, decision: 'INTERESTED'|'DECLINED', by: ObjectId, at: Date,
               availableDates?: string[] /* partial availability (T-04) */, fullPeriod: boolean,
               offeredHeadcount?: number, proposedWorkerIds?: ObjectId[], declineReason?: string,
               availabilitySnapshot: { checkedAt: Date, conflicts: object[], calendarOk: boolean },
               idempotencyKey: string }[],
  currentResponseVersion: number,
  vendorCapacity?: { offeredHeadcount: number, reservedCount: number, confirmedCount: number },
  lockedByProposal: boolean, version: number }
```
Indexes:
- U P `{positionId:1, 'recipient.professionalId':1}` (status in `SENT`, `VIEWED`, `RESPONDED_INTERESTED`)
- U P `{positionId:1, 'recipient.vendorId':1}` (same filter)
- `{jobId:1, positionId:1, status:1}`
- `{'recipient.userId':1, status:1, deadlineAt:-1}`
- `{'recipient.userIds':1, status:1}`
- `{status:1, deadlineAt:1}` (expiry scheduled job)

### `allocation_proposals`
```ts
{ proposalNo: string, jobId: ObjectId, type: 'STANDARD'|'REPLACEMENT', replacesAssignmentId?: ObjectId,
  lines: { lineId: string, positionId: ObjectId, invitationId: ObjectId, responseVersion: number,
           assigneeKind: 'PROFESSIONAL'|'VENDOR_WORKER', professionalId?: ObjectId, vendorId?: ObjectId, workerId?: ObjectId,
           personId: ObjectId, schedule: { startDate, endDate, weekdays, excludedDates, shift },
           payRatePaise?: number, commitmentId?: ObjectId,
           validation: { blocking: { code: string, message: string }[], warnings: { code: string, message: string, acknowledged: boolean }[] } }[],
  status: 'DRAFT'|'PENDING_APPROVAL'|'APPROVED'|'REJECTED'|'CANCELLED',
  createdBy: ObjectId, submittedAt?: Date, approvedBy?: ObjectId, approvedAt?: Date,
  rejectedBy?: ObjectId, rejectedAt?: Date, rejectionReason?: string, clonedFromId?: ObjectId,
  assignmentIds: ObjectId[], version: number }
```
Indexes: U `{proposalNo:1}`; `{jobId:1, status:1}`; `{status:1, submittedAt:1}` (approval queue); `{'lines.personId':1, status:1}`.

### `commitments`
```ts
{ personId: ObjectId, jobId: ObjectId, positionId: ObjectId, proposalId: ObjectId, assignmentId?: ObjectId,
  status: 'HELD'|'CONFIRMED'|'RELEASED', startDate: string, endDate: string, weekdays: number[], excludedDates: string[],
  shift: { startMin: number, endMin: number }, releasedAt?: Date, releaseReason?: string }
```
Indexes: `{personId:1, status:1, startDate:1, endDate:1}` (overlap candidate query: `status in [HELD, CONFIRMED]`, `startDate <= end`, `endDate >= start`); `{proposalId:1}`; `{assignmentId:1}` S.
The overlap check runs in the application after the `persons.scheduleVersion` write lock (ARCH §6.3).

### `assignments`
```ts
{ assignmentNo: string, jobId: ObjectId, positionId: ObjectId, companyId: ObjectId, siteId: ObjectId,
  assigneeKind: 'PROFESSIONAL'|'VENDOR_WORKER', professionalId?: ObjectId, vendorId?: ObjectId, workerId?: ObjectId,
  personId: ObjectId, assigneeUserId?: ObjectId,
  schedule: { startDate, endDate, weekdays, excludedDates, shift, timezone },
  payRatePaise?: number, billRatePaise: number, sourceProposalId: ObjectId, commitmentId: ObjectId,
  status: 'CONFIRMED'|'ACTIVE'|'COMPLETED'|'CANCELLED'|'REPLACED'|'NO_SHOW',
  replacedById?: ObjectId, replacesId?: ObjectId, statusHistory: StatusChange[], version: number }
```
Indexes: U `{assignmentNo:1}`; U P `{jobId:1, personId:1}` (status in `CONFIRMED`, `ACTIVE`); `{personId:1, status:1, 'schedule.startDate':1}`; `{vendorId:1, status:1}`; `{professionalId:1, status:1}`; `{companyId:1, siteId:1, status:1}`.

### `assignment_change_requests`
```ts
{ assignmentId: ObjectId, type: 'CANCELLATION', requestedBy: ObjectId, reason: string,
  status: 'OPEN'|'APPROVED'|'REJECTED', decidedBy?: ObjectId, decidedAt?: Date, note?: string }
```
Indexes: `{assignmentId:1}`; `{status:1, createdAt:1}`.

---

## 10. Execution

### `attendance_records`
```ts
{ assignmentId: ObjectId, jobId: ObjectId, siteId: ObjectId, companyId: ObjectId, personId: ObjectId, vendorId?: ObjectId,
  date: string /* site-local */,
  checkIn?: { at: Date, location?: GeoPoint, accuracyM?: number, distanceM?: number, outsideGeofence: boolean, selfieDocId?: ObjectId, by: ObjectId, proxy: boolean },
  checkOut?: { /* same shape */ },
  workedMinutes?: number, overtimeMinutes?: number,
  companyReview?: { status: 'CONFIRMED'|'DISPUTED', by: ObjectId, at: Date, note?: string, complaintId?: ObjectId },
  noShow: boolean, corrections: { by: ObjectId, at: Date, reason: string, before: object, after: object }[], version: number }
```
Indexes: U `{assignmentId:1, date:1}`; `{jobId:1, date:1}`; `{companyId:1, siteId:1, date:1}`; `{personId:1, date:-1}`.

### `complaints`
```ts
{ complaintNo: string, raisedBy: { userId: ObjectId, userType: string }, ref: { type: 'JOB'|'ASSIGNMENT'|'PAYMENT'|'INVOICE'|'ATTENDANCE', id: ObjectId },
  againstParty?: { type: 'PROFESSIONAL'|'VENDOR'|'VENDOR_WORKER'|'COMPANY'|'PLATFORM', id?: ObjectId },
  category: string, severity: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL', subject: string, description: string, attachmentDocIds: ObjectId[],
  status: 'OPEN'|'IN_PROGRESS'|'RESOLVED'|'CLOSED'|'REOPENED', assignedTo?: ObjectId, slaDueAt: Date, escalationLevel: number,
  comments: { by: ObjectId, at: Date, text: string, internal: boolean, attachmentDocIds: ObjectId[] }[],
  resolution?: { outcome: 'VALID'|'INVALID'|'PARTIAL', note: string, by: ObjectId, at: Date }, version: number }
```
Indexes: U `{complaintNo:1}`; `{status:1, slaDueAt:1}`; `{'ref.type':1, 'ref.id':1}`; `{'raisedBy.userId':1, createdAt:-1}`; `{'againstParty.type':1, 'againstParty.id':1}`.

### `ratings`
`{ assignmentId, companyId, ratedBy, targetKind: 'PROFESSIONAL'|'VENDOR_WORKER', professionalId?, vendorId?, workerId?, stars: 1..5, comment?: string }`
Indexes: U `{assignmentId:1}`; `{professionalId:1}` S; `{workerId:1}` S; `{vendorId:1}` S.

### `performance_snapshots`
`{ subjectKind, subjectId, computedAt, weightsVersion, inputs: {ratingAvg, ratingCount, attendanceRate, noShows, validComplaints, cancellations}, score }`
Indexes: `{subjectKind:1, subjectId:1, computedAt:-1}`.

---

## 11. Finance (Business)

### `invoices`
```ts
{ invoiceNo?: string /* assigned on ISSUE */, financialYear?: string /* '2026-27' */, companyId: ObjectId, jobId: ObjectId,
  basis: 'MILESTONE'|'ATTENDANCE', milestoneRef?: string, period?: { from: string, to: string },
  seller: { gstin: string, stateCode: string, address: Address }, buyer: { legalName, gstin?, stateCode, address },
  placeOfSupply: string,
  lines: { description: string, sacCode: string, quantity: number, unit: string, ratePaise: number,
           amountPaise: number, gstRateBp: number, cgstPaise: number, sgstPaise: number, igstPaise: number, attendanceRefs?: ObjectId[] }[],
  subtotalPaise: number, taxPaise: number, roundOffPaise: number, totalPaise: number,
  creditedPaise: number, paidPaise: number, balancePaise: number,
  issueDate?: string, dueDate?: string, pdfDocId?: ObjectId,
  status: 'DRAFT'|'ISSUED'|'PARTIALLY_PAID'|'PAID'|'OVERDUE'|'CANCELLED'|'VOID',
  issuedBy?: ObjectId, cancelledReason?: string, version: number }
```
Indexes: U P `{invoiceNo:1}` (invoiceNo exists); `{companyId:1, status:1, dueDate:1}`; `{jobId:1}`; `{status:1, dueDate:1}` (overdue scheduled job).
Balance guard: `updateOne({_id, balancePaise:{$gte:x}}, {$inc:{paidPaise:x, balancePaise:-x}})`.

### `credit_notes`
`{ creditNoteNo, financialYear, invoiceId, companyId, reason, lines[], amountPaise, taxPaise, totalPaise, status: 'DRAFT'|'ISSUED'|'CANCELLED', issuedBy, pdfDocId }`
Indexes: U P `{creditNoteNo:1}`; `{invoiceId:1}`.

### `business_payments`
```ts
{ paymentNo: string, companyId: ObjectId, mode: 'ONLINE'|'OFFLINE',
  method?: 'BANK_TRANSFER'|'NEFT'|'RTGS'|'IMPS'|'CHEQUE'|'UPI_DIRECT'|'CASH'|'OTHER',
  intendedInvoiceIds: ObjectId[], amountPaise: number, currency: 'INR',
  gateway?: { orderId: string, paymentId?: string, signatureVerifiedAt?: Date, method?: string, feePaise?: number, taxPaise?: number, settlementId?: string },
  offline?: { reference: string, bank?: string, paidOn: string, proofDocId: ObjectId,
              cheque?: { number: string, date: string, status: 'RECEIVED'|'DEPOSITED'|'CLEARED'|'BOUNCED', history: StatusChange[] } },
  status: 'CREATED'|'PENDING_CONFIRMATION'|'PENDING_VERIFICATION'|'SUCCESS'|'FAILED'|'REJECTED'|'PARTIALLY_REFUNDED'|'REFUNDED',
  capturedPaise: number, allocatedPaise: number, unappliedPaise: number, refundedPaise: number,
  recordedBy: ObjectId, verifiedBy?: ObjectId, verifiedAt?: Date, rejectionReason?: string,
  reconciliation?: { status: 'UNRECONCILED'|'MATCHED'|'EXCEPTION', itemId?: ObjectId }, version: number }
```
Indexes:
- U `{paymentNo:1}`
- U P `{'gateway.orderId':1}`, U P `{'gateway.paymentId':1}`
- U P `{method:1, 'offline.reference':1, 'offline.bank':1}` (mode OFFLINE; status not in `REJECTED`, `FAILED`) — FR-BPAY-07
- `{companyId:1, createdAt:-1}`
- `{status:1, mode:1, createdAt:1}` (verification queue and sweeper)
- `{'reconciliation.status':1}`

Refund guard: `updateOne({_id, $expr:{$lte:[{$add:['$refundedPaise', x]}, '$capturedPaise']}}, {$inc:{refundedPaise:x}})`.

### `payment_allocations`
`{ paymentId, invoiceId, companyId, amountPaise, allocatedBy, allocatedAt, reversedAt?, reversalReason? }`
Indexes: `{paymentId:1}`; `{invoiceId:1}`.

### `business_refunds`
Same shape as `registration_refunds`, with `paymentId` referring to `business_payments`. Same indexes.

### `reconciliation_runs`
```ts
{ runNo: string, source: 'RAZORPAY_PAYMENTS'|'RAZORPAY_SETTLEMENTS'|'BANK_STATEMENT', book?: 'REGISTRATION'|'BUSINESS'|'ALL',
  period: { from: string, to: string }, statementDocId?: ObjectId, columnMapping?: Record<string, string>,
  status: 'QUEUED'|'RUNNING'|'COMPLETED'|'FAILED',
  counts: { total: number, matched: number, unmatched: number, exceptions: number, resolved: number },
  startedBy?: ObjectId /* null for the scheduled job */, startedAt: Date, completedAt?: Date, error?: string }
```
Indexes: U `{runNo:1}`; `{source:1, 'period.from':-1}`.

### `reconciliation_items`
```ts
{ runId: ObjectId, externalRef?: string, externalAmountPaise?: number, externalDate?: string, externalStatus?: string,
  local?: { domain: 'REGISTRATION'|'BUSINESS', paymentId: ObjectId, amountPaise: number, status: string },
  bankLineId?: ObjectId,
  result: 'MATCHED'|'MISSING_LOCAL'|'MISSING_EXTERNAL'|'AMOUNT_MISMATCH'|'STATUS_MISMATCH'|'UNMATCHED',
  matchMethod?: 'AUTO_REF'|'AUTO_AMOUNT_DATE'|'MANUAL',
  resolution?: { status: 'OPEN'|'RESOLVED', note: string, by: ObjectId, at: Date } }
```
Indexes: `{runId:1, result:1}`; `{'local.paymentId':1}`; `{externalRef:1}`.

### `bank_statement_lines`
`{ runId, lineNo, txnDate, valueDate?, description, reference?, debitPaise, creditPaise, balancePaise?, matchedPaymentRef?: {domain, paymentId}, status: 'UNMATCHED'|'MATCHED'|'IGNORED', hash }`
Indexes: `{runId:1, status:1}`; U `{hash:1}` (prevents importing the same line twice; the hash is SHA-256 of date, amount, reference and description).

---

## 12. Notifications and Reports

### `notification_templates`
```ts
{ eventType: string /* 'invitation.sent' */, channel: 'WHATSAPP'|'SMS'|'EMAIL'|'IN_APP', locale: 'en'|'hi',
  audience: 'PROFESSIONAL'|'VENDOR'|'VENDOR_WORKER'|'COMPANY'|'ADMIN',
  whatsapp?: { templateName: string, language: string, paramOrder: string[] },
  sms?: { dltTemplateId: string, body: string }, email?: { subject: string, html: string }, inApp?: { title: string, body: string, link?: string },
  variables: string[], isActive: boolean, version: number }
```
Indexes: U `{eventType:1, channel:1, locale:1, audience:1}`.

### `notifications`
```ts
{ userId: ObjectId, eventType: string, eventId: string, channel: string, priority: 'CRITICAL'|'NORMAL',
  payload: object, rendered?: { title?: string, body?: string, link?: string },
  status: 'QUEUED'|'SENT'|'DELIVERED'|'READ'|'FAILED'|'SKIPPED_PREF'|'SKIPPED_NO_TEMPLATE'|'SKIPPED_NO_CONTACT'|'DEFERRED_QUIET',
  providerMessageId?: string, attempts: number, lastError?: string, sentAt?: Date, deliveredAt?: Date, readAt?: Date }
```
Indexes: U `{eventId:1, userId:1, channel:1}` (send idempotency); `{userId:1, channel:1, readAt:1, createdAt:-1}` (inbox); U P `{providerMessageId:1}`; TTL `{createdAt:1}` (180 days).

### `notification_preferences`
`{ userId, channels: { WHATSAPP: boolean, SMS: boolean, EMAIL: boolean }, mutedEventTypes: string[] }` — Index: U `{userId:1}`.

### `report_exports`
`{ reportCode, filters, format: 'CSV'|'XLSX', requestedBy, status: 'QUEUED'|'RUNNING'|'READY'|'FAILED', fileDocId?, rowCount?, error?, expiresAt }` — Indexes: `{requestedBy:1, createdAt:-1}`; TTL `{expiresAt:1}`.

---

## 13. Transaction Boundaries

| Use case | Documents written in one transaction |
|---|---|
| Provider approval | `provider_registrations`, `professionals`/`vendors` status, `persons.isActive`, audit, outbox |
| Add vendor worker | `vendors.activeWorkerCount` (cap guard), `persons` claim, `vendor_workers`, audit |
| Registration payment success (webhook or verify) | `registration_payments`, `provider_registrations.payment`, provider status `PENDING_PAYMENT→PENDING_VERIFICATION` if submitted, `ledger_entries`, `webhook_events.status`, outbox |
| Quotation accept | `quotations`, `enquiries`, `jobs` (+ `counters`), audit, outbox |
| Invitation response | `invitations` (conditional), audit, outbox. **No writes to assignments or commitments.** |
| Proposal submit | `allocation_proposals`, `jobs.positions` (held), `invitations.vendorCapacity` (reserved), `persons.scheduleVersion`, `commitments` (HELD), audit |
| Proposal approve | `allocation_proposals`, `persons.scheduleVersion`, `commitments` (CONFIRMED), `jobs` (counts and status), `invitations` (`lockedByProposal`, vendor `confirmedCount`), `assignments` (+ `counters`), [replacement: old `assignment` → REPLACED and its commitment RELEASED, position `confirmed` unchanged], audit, outbox |
| Proposal reject or cancel | `allocation_proposals`, `jobs.positions` (release held), `invitations.vendorCapacity`, `commitments` (RELEASED), audit, outbox |
| Invoice issue | `invoices` (+ `counters` invoice FY), `ledger_entries` (AR Dr / Revenue Cr / GST Cr), audit, outbox |
| Business payment success | `business_payments`, `payment_allocations`, `invoices` (balances and status), `ledger_entries`, `webhook_events`, outbox |
| Offline payment verify | Same as above, plus a maker-checker check in the service |
| Refund request | `*_payments.refundedPaise` (guard), `*_refunds`, audit. The gateway call happens after the commit, from a worker. |
| Refund processed | `*_refunds.status`, `*_payments.status`, `ledger_entries`, outbox |

The `TransactionRunner` retries a transaction on `TransientTransactionError`, including the `WriteConflict` produced by the person lock, up to `db.txnMaxRetries` (default 5), with jittered backoff.

---

## 14. Data Retention

| Data | Retention |
|---|---|
| Financial records, ledger, invoices, financial audit | Permanent (statutory minimum 8 years) |
| Non-financial audit logs | 7 years (TTL) |
| OTP challenges | 1 hour after expiry |
| Idempotency keys | 24 hours |
| Dispatched outbox events, processed events | 30 days |
| Notification delivery logs | 180 days |
| Report export files | 7 days |
| DPDP erasure | PII fields are anonymised (name → "Deleted user", mobile, email and IDs removed, documents purged). Financial references are kept. |

---

## 15. Bijli Wala v2 Collections (requirement document §11)

### 15.1 Entity mapping
The requirement document lists the minimum entities as relational tables. Bijli Wala keeps MongoDB (SRS §2.3), so each entity maps to a collection, an embedded array, or an existing collection, as below. "Built" means the collection exists in Phases 1–4.

| Requirement doc entity | Bijli Wala collection | Status |
|---|---|---|
| users, roles, permissions, user_roles, role_permissions | `users`, `roles` (permissions embedded as codes), `role_assignments`. The permission catalogue lives in `packages/contracts`. | Built |
| departments | `departments` + `role_assignments.departmentId` + `users.departmentIds` | New |
| states, districts, cities, pin_codes | `states`, `districts`, `cities`, `pin_codes` | New |
| technicians | `professionals`, `vendor_workers`, with identity in `persons`; `employeeNo` added | Built (+ fields) |
| technician_skills | `professionals.skills[]`, `vendor_workers.skills[]` | Built |
| qualifications, experience_records | `professionals.qualifications[]`, `professionals.experience[]` (new embedded arrays) | New fields |
| technician_documents, client_documents | `documents` (`ownerType` + `ownerId`) | Built |
| availability | `professionals.availability`, `commitments` | Built / Phase 5 |
| vendors, vendor_employees | `vendors`, `vendor_workers` | Built |
| clients | `companies`, `company_sites` | Built |
| requirements, requirement_skills | `enquiries` (positions embedded; `enquiryNo` is shown as the Requirement ID) | Built (+ fields) |
| quotations, quotation_items | `quotations` (`lines[]` embedded) | Built |
| projects | `jobs` (positions embedded; `jobNo` is shown as the Project ID) | Built |
| work_orders | `work_orders` | New |
| assignments | `assignments`, `commitments` | Phase 5 |
| attendance, leave_requests | `attendance_records`, `leave_requests` | Phase 6 |
| payroll | `payroll_runs`, `payroll_lines` | New |
| invoices, invoice_items | `invoices` (`lines[]` embedded), `credit_notes` | Phase 7 |
| payments, refunds | `registration_payments` / `business_payments` / `ad_payments`, `*_refunds`, `ledger_entries` | Partial |
| ad_slots, ad_packages, ad_campaigns, ad_creatives | `ad_slots`, `ad_packages`, `ad_campaigns`, `ad_creatives` | New |
| campaign_targeting | `ad_campaigns.targeting` (embedded) | New |
| ad_impressions, ad_clicks | `ad_events` (`type: IMPRESSION`/`CLICK`, TTL) + `ad_stats_hourly` | New |
| notifications | `notifications`, `notification_templates`, `notification_preferences`, `push_subscriptions` | Built (+ push) |
| cms_pages, cms_media | `cms_pages`, `cms_media`, `cms_menus` | New |
| audit_logs | `audit_logs` | Built |
| system_settings | `business_settings` | Built |

Every important record has `createdAt`, `updatedAt`, `createdBy` and `updatedBy` (§1).

### 15.2 Geography and departments

#### `states`
`{ code: 'MH', name, gstStateCode: '27', isUT: boolean, isActive }` — Indexes: U `{code:1}`, U `{gstStateCode:1}`.

#### `districts`
`{ stateId, name, isActive }` — Indexes: U `{stateId:1, name:1}`.

#### `cities`
`{ stateId, districtId, name, slug, location?: Point, isActive, hasCmsPage: boolean }` — Indexes: U `{stateId:1, slug:1}`, `{districtId:1}`, 2dsphere `{location:1}` (S).

#### `pin_codes`
`{ pinCode: '411001', stateId, districtId, cityId?, location?: Point }` — Indexes: U `{pinCode:1}`, `{cityId:1}`.

#### `departments`
`{ code: 'HR', name, description, isActive, isSystem }` — Index: U `{code:1}`. Seeded with the ten departments in SRS FR-DEP-01.

`role_assignments` gains `departmentId?` and `scope` gains `{ type: 'STATE', stateIds[] }` and `{ type: 'CITY', cityIds[] }`. Address sub-documents across collections gain `stateId`, `districtId`, `cityId` and `pinCode`, with indexes on `{'address.stateId':1}` and `{'address.cityId':1}` wherever geo-scoped lists are queried.

### 15.3 Technician additions
- `professionals` gains:
  - `employeeNo` (U, from `counters` key `employee`)
  - `qualifications[] { level: ITI|DIPLOMA|DEGREE|OTHER, title, institute, passingYear, docId? }`
  - `experience[] { company, role, from, to?, projectSummary }`
  - `workPreferences { employmentStatus, availableFrom, preferredStateIds[], preferredCityIds[], willingToRelocate, willingToTravel, employmentType, expectedDailyWagePaise, expectedMonthlySalaryPaise, shiftPreference }`
  - `emergencyContact { name, relation, mobile }`
  - `declarations[] { code, policyVersion, acceptedAt, ip, userAgent }`
  - `operationalStatus: AVAILABLE|TEMPORARILY_UNAVAILABLE|ON_ASSIGNMENT` (derived and maintained by assignment events)
- `vendor_workers` gains `employeeNo` (U) and the same `qualifications` and `operationalStatus`.

### 15.4 Work orders and payroll

#### `work_orders`
`{ workOrderNo, version, supersedesId?, companyId, jobId, quotationId, enquiryId, status: DRAFT|ISSUED|CLIENT_SIGNED|ACTIVE|COMPLETED|CANCELLED|AMENDED, terms: { lines[{ skillId, categoryId, headcount, billRatePaise, unit, dutyHours }], contractStart, contractEnd, paymentTerms, overtimeTerms, replacementTerms, responsibilities, taxes }, pdfDocId?, issuedAt?, clientSignedBy?, clientSignedAt?, clientSignedIp?, signatories[], version }` — Indexes: U `{workOrderNo:1, version:1}`, `{jobId:1, status:1}`, `{companyId:1, createdAt:-1}`.

#### `leave_requests`
`{ personId, assignmentId?, from, to, type, reason, status: PENDING|APPROVED|REJECTED|CANCELLED, decidedBy?, decidedAt? }` — Indexes: `{personId:1, from:1}`, `{status:1}`.

#### `payroll_runs`
`{ runNo, periodFrom, periodTo, scope: { companyId?, jobId?, vendorId? }, status: DRAFT|CALCULATED|APPROVED|PARTIALLY_PAID|PAID|CANCELLED, totals: { grossPaise, deductionsPaise, netPaise }, preparedBy, approvedBy?, approvedAt?, version }` — Indexes: U `{runNo:1}`, `{status:1, periodTo:-1}`.

#### `payroll_lines`
`{ runId, payeeType: PROFESSIONAL|VENDOR, payeeId, personId, assignmentIds[], days, hours, overtimeMinutes, wagePaise, overtimePaise, allowances[{code, amountPaise}], deductions[{code, amountPaise}], netPaise, status: PENDING|PAID|ON_HOLD, paidAt?, transactionRef?, payslipDocId? }` — Indexes: `{runId:1}`, `{payeeId:1, createdAt:-1}`, `{personId:1}`.

`attendance_records` gains `payrollRunId?` (P index `{payrollRunId:1}`) and `billedInvoiceId?`. Each is set once by a conditional update, which prevents paying or billing the same day twice.

### 15.5 Advertising

#### `advertisers`
`{ advertiserNo, companyName, brandName, contact { name, designation, mobile, email }, website, gstin?, address (with geo ids), productCategoryIds[], description, logoDocId?, status: PENDING|APPROVED|ACTIVE|REJECTED|SUSPENDED, statusReason?, version }` — Indexes: U `{advertiserNo:1}`, `{status:1}`, U P `{gstin:1}` (when present).

#### `ad_product_categories`
`{ name, slug, isActive, order }` — Index: U `{slug:1}`.

#### `ad_slots`
`{ slotKey (U), name, page, section, position, devices[], width, height, maxBytes, formats[], campaignTypes[], pricingModels[], basePricePaise, capacity, priorityEnabled, requiresApproval, dailyImpressionLimit?, status: ENABLED|DISABLED, exclusiveReservations[{ campaignId, from, to }] }` — Indexes: U `{slotKey:1}`, `{page:1, status:1}`.

#### `ad_slot_inventory`
`{ slotId, day: 'YYYY-MM-DD', booked, capacity, exclusiveCampaignId? }` — Index: U `{slotId:1, day:1}`. A conditional `$inc` guards capacity, the same pattern as job positions.

#### `ad_packages`
`{ code (U), name, pricingModel: FIXED_DAILY|FIXED_WEEKLY|FIXED_MONTHLY|CPC|CPM, slotIds[], pricePaise, gstRateBp, minBudgetPaise?, isActive, effectiveFrom, effectiveTo? }` — Indexes: U `{code:1}`, `{isActive:1}`. **Prices live only here** (BR-ADV-02).

#### `ad_campaigns`
`{ campaignNo, advertiserId, name, objective, packageSnapshot, slotIds[], pages[], targeting { allIndia, stateIds[], cityIds[], productCategoryIds[], devices[] }, startAt, endAt, budgetPaise, spentPaise, impressionCap?, frequencyCapPerDay?, priority, status, statusHistory[], reviewNotes?, paymentId?, version }` — Indexes: U `{campaignNo:1}`, `{advertiserId:1, createdAt:-1}`, `{status:1, startAt:1}`, `{status:1, endAt:1}`.

#### `ad_creatives`
`{ campaignId, headline, desktopDocId, mobileDocId?, bannerDocId?, destinationUrl, width, height, mime, bytes, status: PENDING|APPROVED|REJECTED|REPLACED, publicUrl?, reviewedBy? }` — Index: `{campaignId:1, status:1}`.

#### `ad_payments` / `ad_refunds`
These have the same shape as `registration_payments` and `registration_refunds`, with `campaignId` and ledger book `ADVERTISING`. Indexes: U `{gatewayOrderId:1}` (S), `{campaignId:1}`.

#### `ad_events`
`{ type: IMPRESSION|CLICK, campaignId, creativeId, slotId, tokenId (U), at, visitorHash, ipHash, stateId?, cityId?, device, valid: boolean, invalidReason? }` — Indexes: U `{tokenId:1}`, `{campaignId:1, at:1}`, TTL `{at:1}` (90 days).

#### `ad_stats_hourly`
`{ campaignId, slotId, hour: Date, impressions, clicks, spendPaise, byState: {}, byDevice: {} }` — Index: U `{campaignId:1, slotId:1, hour:1}`. Retained permanently for advertiser reporting.

### 15.6 CMS and push

#### `cms_pages`
`{ slug (U), type: STATIC|CATEGORY|CITY|INDUSTRY|SERVICE, title, draft: Block[], published: Block[], publishedAt?, publishedBy?, seo { title, description, ogImageDocId?, canonical? }, cityId?, categoryId?, status: DRAFT|PUBLISHED|ARCHIVED, version }` — Indexes: U `{slug:1}`, `{type:1, status:1}`.

#### `cms_media`
`{ docId, alt, width, height, publicUrl, tags[] }` — Index: `{tags:1}`.

#### `cms_menus`
`{ key: HEADER|FOOTER|…, items[{ label, href, children[] }] }` — Index: U `{key:1}`.

#### `push_subscriptions`
`{ userId, endpoint (U), keys { p256dh, auth }, userAgent, lastSeenAt }` — Indexes: U `{endpoint:1}`, `{userId:1}`.

### 15.7 v2 transaction boundaries

| Use case | Documents written in one transaction |
|---|---|
| Quotation accept (v2) | Same as §13, plus `work_orders` (DRAFT, + `counters`) |
| Work order client sign-off | `work_orders` (conditional), `jobs` (deployment allowed), audit, outbox |
| Technician submit (v2) | `professionals` (declarations, `employeeNo` from `counters`), `provider_registrations`, audit, outbox |
| Payroll calculate | `payroll_runs`, `payroll_lines`, `attendance_records.payrollRunId` (conditional on null) |
| Payroll approve or pay | `payroll_runs`, `payroll_lines`, `ledger_entries` (book PAYROLL), audit, outbox |
| Campaign approve | `ad_campaigns` (conditional), `ad_slot_inventory` (capacity guard per day), audit, outbox |
| Ad payment success (webhook) | `ad_payments`, `ad_campaigns` (PAYMENT_PENDING → SCHEDULED), `ledger_entries` (book ADVERTISING), `webhook_events`, outbox |
| Campaign expiry | `ad_campaigns` (conditional), `ad_slot_inventory` (release future days), outbox |
| Hourly ad roll-up | `ad_stats_hourly` (upsert), `ad_campaigns.spentPaise` (conditional `$inc` capped at budget) |
| CMS publish | `cms_pages` (draft → published, version), audit, outbox (prerender) |
