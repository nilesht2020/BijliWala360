# Software Requirements Specification
## SkillConnect — B2B Service Marketplace Platform

| Field | Value |
|---|---|
| Document | Software Requirements Specification (SRS) |
| Version | 1.0 (Draft for sign-off) |
| Date | 2026-11-13 |
| Status | Draft. Section 13 lists the assumptions that need confirmation. |

---

## 1. Introduction

### 1.1 Purpose
This document sets out the functional and non-functional requirements for SkillConnect. SkillConnect is a business-to-business marketplace. Companies use it to source skilled service providers for on-site and project work, either individual professionals or vendors and contractors who manage a team of workers. The platform team controls who is allocated to each job.

This document is the source of truth for the architecture, database design, API contract, development plan and test plan.

### 1.2 Scope
SkillConnect provides:
- Onboarding, verification and one-time paid registration for service providers (individual professionals and vendors).
- Onboarding of business clients (companies), and handling their service enquiries and quotations.
- Job creation, candidate matching, invitations, availability collection, and **admin-controlled allocation** through approved allocation proposals.
- Assignment execution, with attendance and work tracking.
- Business service payments, both online (Razorpay) and offline (bank transfer, cheque and similar), with invoicing, refunds and reconciliation.
- Notifications through WhatsApp, SMS, email and in-app channels.
- Complaints, reports and a full audit trail.

The platform has three client surfaces:
1. **Public website**: service catalogue, provider sign-up and business enquiry.
2. **Web portals**: Company portal, Provider portal (Professional or Vendor) and Admin console.
3. **Mobile-responsive provider workflows**: responding to invitations, attendance and documents. There is no native app in the MVP.

### 1.3 Definitions

| Term | Definition |
|---|---|
| Company / Client | A business organisation that buys services through the platform. |
| Provider | Either an Individual Professional or a Vendor. |
| Individual Professional | A self-employed skilled person who registers and works in their own name. |
| Vendor | A contractor or agency organisation that registers once and supplies multiple workers. |
| Vendor Worker | A person employed or managed by a Vendor. Workers are onboarded under the vendor's registration. |
| Service Category | A hierarchical classification of services, for example Electrical → Industrial Wiring. |
| Skill | A specific competency tagged on providers and required by jobs. |
| Registration Plan | A configurable one-time fee plan that applies to a provider type. |
| Enquiry | A company's request for a service before it is priced. |
| Quotation | A priced offer that the platform sends to a company in response to an enquiry. |
| Job | A confirmed unit of work, created from an accepted quotation or directly by an admin. |
| Position / Requirement Line | A line on a job that says how many workers with a given skill are needed, for example 4 × Electrician (HT certified). |
| Matching | System scoring and ranking of eligible providers for a job. |
| Invitation | An offer sent to a professional or vendor to express interest in a job. |
| Invitation Response | A provider's reply to an invitation: interested with availability, declined, or, for vendors, interested with an offered headcount. |
| Allocation Proposal | A draft set of candidate-to-position allocations that an admin assembles and that needs approval. |
| Assignment | A confirmed engagement of a specific person (a professional or a vendor worker) on a job. Created **only** when an allocation proposal is approved. |
| Commitment | A time window in which a person is already assigned. Used to prevent double-booking. |
| Registration Payment | The one-time fee a provider pays to register. It is kept separate from business payments. |
| Business Payment | Money a company pays for services, recorded against an invoice. |
| Reconciliation | Matching recorded payments against gateway settlements or bank statements, and against invoices. |

### 1.4 References
- Business decisions supplied by the product owner (provider model, registration fee, allocation and payments).
- Razorpay Orders, Payments, Refunds and Webhooks API documentation.
- WhatsApp Business Cloud API documentation.
- Indian GST invoicing rules (for invoice format).
- Digital Personal Data Protection Act, 2023 (India).

---

## 2. Overall Description

### 2.1 Product Perspective
SkillConnect is a new, standalone system built as a modular monolith with a single deployable backend. It integrates with these external services:

| System | Purpose |
|---|---|
| Razorpay | Online registration fees and business payments, refunds and webhooks. |
| WhatsApp Business API | Template-based transactional notifications. |
| SMS provider (DLT-registered) | OTP delivery and fallback notifications. |
| Email (SMTP or transactional provider) | Invoices, receipts and account emails. |
| S3-compatible object storage | Documents, images, invoices and attendance photos. |

### 2.2 User Classes and Roles

| Role | Surface | Description |
|---|---|---|
| Super Admin | Admin | Full access, including system configuration and role management. |
| Operations Admin | Admin | Manages enquiries, quotations, jobs, matching, invitations and allocation proposals. |
| Allocation Approver | Admin | Approves or rejects allocation proposals. May be the same person as Operations Admin if configured; see BR-ALC-07. |
| Verification Officer | Admin | Reviews provider documents and profiles, and approves or rejects registrations. |
| Finance Admin | Admin | Registration fees, invoices, verification of offline payments, refunds and reconciliation. |
| Support Agent | Admin | Handles complaints. Read-only access to related records. |
| Company Admin | Company | Manages the company profile, users, enquiries, quotations, jobs, payments and complaints. |
| Company User | Company | Raises enquiries and views jobs and attendance for their own sites. Restricted access to finance. |
| Individual Professional | Provider | Manages their own profile, documents and registration, responds to invitations, and records attendance. |
| Vendor Admin | Provider | Manages the vendor profile, workers and registration, responds to invitations with capacity, and manages assignments. |
| Vendor Worker | Provider (light) | Optional OTP login to view their own assignments and mark attendance. Cannot respond to invitations. |

Permissions are defined as fine-grained permission codes, for example `allocation.approve`. Roles are configurable bundles of these codes.

### 2.3 Operating Environment
- Backend: Node.js LTS, NestJS, MongoDB replica set (required for transactions), Redis and BullMQ.
- Frontend: React SPA running in current versions of Chrome, Edge, Safari and Firefox, and in mobile browsers on Android 10+ and iOS 15+.
- Deployment: Docker containers with separate API and worker processes.
- Locale: India first. Currency is INR, the time zone is Asia/Kolkata for display and data is stored in UTC. English is the UI language in the MVP, and the i18n structure is ready for Hindi.

### 2.4 Design and Implementation Constraints
- The technology stack is fixed (see the project brief).
- MongoDB multi-document transactions are used for allocation and financial operations.
- No business configuration may be hardcoded. This covers fees, tax rates, matching weights, invitation expiry, notification templates, cancellation windows and similar values.
- WhatsApp messages must use pre-approved templates.
- SMS must follow India's DLT regulations (registered sender ID and templates).

### 2.5 Assumptions and Dependencies
- Razorpay merchant account, WhatsApp Business account and DLT registration are available before UAT.
- Background verification (police checks and similar) is done manually by the Verification Officer in the MVP. There is no third-party KYC API.
- The platform invoices companies directly. Provider payouts are handled outside the system in the MVP; see Section 12.

---

## 3. Functional Requirements: Authentication and Users

### 3.1 Authentication (AUTH)

| ID | Requirement |
|---|---|
| FR-AUTH-01 | Providers and company users register and log in with a mobile number and OTP. |
| FR-AUTH-02 | Admin users log in with email and password, and TOTP-based MFA is mandatory. |
| FR-AUTH-03 | Company users may also set a password for email login. |
| FR-AUTH-04 | OTPs are 6 digits, expire after a configurable time (default 5 minutes), allow at most a configurable number of verification attempts (default 5), and are rate-limited per number and per IP. Resend has a configurable cooldown (default 30 seconds). |
| FR-AUTH-05 | Successful login issues a short-lived JWT access token (default 15 minutes) and a rotating refresh token (default 30 days), stored hashed. Reusing a refresh token revokes the whole token family. |
| FR-AUTH-06 | Users can log out, which revokes the refresh token. Admins can force logout of any user. |
| FR-AUTH-07 | Password reset works by email link for admins and company users with passwords. |
| FR-AUTH-08 | Account lockout is temporary after a configurable number of failed attempts. |
| FR-AUTH-09 | All authentication events are written to the audit log: login, failure, OTP request, logout and token revocation. |

### 3.2 Users and RBAC (USR)

| ID | Requirement |
|---|---|
| FR-USR-01 | A single `User` identity holds credentials, contact details and status (`ACTIVE`, `SUSPENDED`, `DEACTIVATED`). |
| FR-USR-02 | Each user has one or more role assignments, scoped to the platform, a specific company or a specific vendor. |
| FR-USR-03 | The Super Admin manages roles and their permission codes. System roles cannot be deleted. |
| FR-USR-04 | Every API endpoint declares its required permission and scope check, which the server enforces. |
| FR-USR-05 | A mobile number and an email address are each unique across all users. |
| FR-USR-06 | Users can update their own profile. Changing the mobile number or email requires OTP or link verification. |

---

## 4. Functional Requirements: Provider Management and Registration

### 4.1 Individual Professionals (PRO)

| ID | Requirement |
|---|---|
| FR-PRO-01 | A professional profile holds full name, photo, date of birth, gender (optional), address, service location (geo point and travel radius in km), languages, years of experience, service categories, skills (each with a proficiency level and years), certifications, and bank details. Bank details are used for payouts outside the system and are stored encrypted. |
| FR-PRO-02 | The profile tracks completion percentage, and a profile cannot be submitted for verification until all mandatory fields and documents are present. |
| FR-PRO-03 | A professional maintains an **availability calendar**: recurring weekly availability plus specific blocked dates. |
| FR-PRO-04 | Profile lifecycle states: `DRAFT → PENDING_PAYMENT → PENDING_VERIFICATION → (CHANGES_REQUESTED ↔ PENDING_VERIFICATION) → APPROVED / REJECTED`, plus `SUSPENDED` and `DEACTIVATED`. |
| FR-PRO-05 | Only `APPROVED` professionals who are not suspended are eligible for matching and invitations. |
| FR-PRO-06 | After approval, editing verified fields (identity, certifications) sets those fields to pending re-verification. The professional stays approved for unaffected skills. |

### 4.2 Vendors (VEN)

| ID | Requirement |
|---|---|
| FR-VEN-01 | A vendor profile holds legal name, trade name, entity type, GSTIN (optional or mandatory per plan), PAN, registered address, operating locations (multiple geo points with radii), service categories, contact persons and bank details (encrypted). |
| FR-VEN-02 | A vendor has one or more Vendor Admin users. |
| FR-VEN-03 | The vendor lifecycle is the same as FR-PRO-04. |
| FR-VEN-04 | A vendor can be eligible for matching only when it is `APPROVED` and has at least one `ACTIVE`, verified worker. |

### 4.3 Vendor Workers (VWK)

| ID | Requirement |
|---|---|
| FR-VWK-01 | Vendor Admins add workers with name, mobile number (optional but recommended), photo, ID document, skills, experience, certifications and base location. |
| FR-VWK-02 | Workers are covered by the vendor's one-time registration. No separate worker fee applies unless the registration plan sets a worker cap (see FR-REG-03). |
| FR-VWK-03 | Each worker is verified by the Verification Officer. States: `PENDING_VERIFICATION`, `ACTIVE`, `REJECTED`, `INACTIVE`. |
| FR-VWK-04 | A person's identity is unique across the platform, using the hashed government ID number and the mobile number. The same person cannot be an active worker for two vendors at once, or be both an active professional and an active vendor worker. Conflicts go to the admin for resolution. |
| FR-VWK-05 | A worker has their own availability calendar and commitments, maintained by the vendor and reflected from assignments. |
| FR-VWK-06 | A vendor can deactivate a worker. Workers with future confirmed assignments cannot be deactivated until those assignments are replaced or cancelled. |

### 4.4 Service Categories and Skills (CAT)

| ID | Requirement |
|---|---|
| FR-CAT-01 | Admins manage a category tree with up to 3 levels. Each category has a name, slug, description, image, icon, display order, active flag and SEO fields. |
| FR-CAT-02 | Admins manage a skills master list, each skill linked to one or more categories, plus the mandatory documents or certifications for that skill, for example an electrical licence. |
| FR-CAT-03 | The public website lists active categories with large images and rounded cards. |
| FR-CAT-04 | A category cannot be deleted while it is in use. It is deactivated instead. |

### 4.5 Registration Plans (PLN)

| ID | Requirement |
|---|---|
| FR-PLN-01 | Admins define registration plans with: name, code, provider type (`PROFESSIONAL` or `VENDOR`), fee amount, GST rate, included features, maximum workers (vendors only, nullable meaning unlimited), mandatory document types, validity flag (`ONE_TIME`), active flag, and effective dates. |
| FR-PLN-02 | Several active plans may exist per provider type, for example Vendor Basic (up to 25 workers) and Vendor Enterprise (unlimited). |
| FR-PLN-03 | Changing a plan's price does not affect providers who have already paid. The plan's terms are snapshotted onto the provider's registration record. |
| FR-PLN-04 | **No recurring or annual renewal** in the MVP. |
| FR-PLN-05 | A vendor may upgrade its plan (for example to raise the worker cap) by paying the difference. Upgrades create a new registration payment linked to the original. |
| FR-PLN-06 | Admins may waive or discount a registration fee with a reason. The waiver is audited and requires the `registration.waive` permission. |

### 4.6 Registration Workflow (REG)

```
Mobile OTP → Account created → Choose provider type → Profile completion
→ Document upload → Select plan → Pay registration fee (Razorpay or offline)
→ Submit for verification → Verification Officer review
→ (Changes requested ↺) → Approved / Rejected → Notification
```

| ID | Requirement |
|---|---|
| FR-REG-01 | A provider chooses `PROFESSIONAL` or `VENDOR` after OTP verification. The choice cannot be changed after payment. |
| FR-REG-02 | The registration fee is paid online through Razorpay (Order, then Checkout, then signature verification, then webhook confirmation). Offline payment is possible only if the plan allows it, and requires Finance verification. |
| FR-REG-03 | If a vendor exceeds its plan's worker cap, it must upgrade before adding more active workers. |
| FR-REG-04 | Payment is required **before** verification review. An admin with `registration.waive` can override this. |
| FR-REG-05 | If a registration is rejected, the refund follows the configurable refund policy for that plan: full, partial or none. Refunds run through the Refunds flow. |
| FR-REG-06 | The Verification Officer sees a checklist for each document and field, and can approve, reject or request changes, with comments per item. |
| FR-REG-07 | Approval sets the provider to `APPROVED`, records the verifier, timestamp and checklist snapshot, and triggers a welcome notification. |
| FR-REG-08 | Registration payments are stored in a **separate collection and ledger** from business payments. |

### 4.7 Documents (DOC)

| ID | Requirement |
|---|---|
| FR-DOC-01 | Admins configure the supported document types: Aadhaar (masked), PAN, GST certificate, trade licence, skill certificate, police verification, cancelled cheque, and others. Each type defines its owner type, allowed MIME types, maximum size, whether it is mandatory, whether it has an expiry, and whether a number field is captured. |
| FR-DOC-02 | Uploads go through presigned URLs to private object storage. The backend validates MIME type by magic bytes, size and extension, and runs a virus scan (ClamAV or equivalent) before marking the document `UPLOADED`. |
| FR-DOC-03 | Files are never public. Downloads use short-lived presigned URLs and are authorised per request. |
| FR-DOC-04 | Document states: `PENDING_UPLOAD`, `UPLOADED`, `VERIFIED`, `REJECTED`, `EXPIRED`. |
| FR-DOC-05 | Sensitive ID numbers are stored encrypted, plus a hash for duplicate detection. Only the last 4 digits are displayed. Full Aadhaar numbers are never stored; masked Aadhaar images are required. |
| FR-DOC-06 | Documents that expire trigger reminders a configurable number of days before expiry. When a document expires, the affected skill or provider becomes ineligible for matching until it is renewed. |
| FR-DOC-07 | Re-uploading a document creates a new version. Previous versions are kept for audit. |

---

## 5. Functional Requirements: Companies, Enquiries and Quotations

### 5.1 Companies (CMP)

| ID | Requirement |
|---|---|
| FR-CMP-01 | A company registers with legal name, GSTIN (optional), PAN, billing address, industry, size, primary contact (OTP verified), and one or more **sites**, each with an address, geo point and site contact. |
| FR-CMP-02 | Company states: `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`. An admin activates a company after a basic KYC check. Enquiries are allowed while the company is pending; jobs are not. |
| FR-CMP-03 | A Company Admin invites company users and assigns them the Company Admin or Company User role, optionally restricted to specific sites. |
| FR-CMP-04 | Each company has configurable commercial terms: credit period in days, a credit limit (optional), whether offline payment is allowed, and whether an advance percentage is required. |

### 5.2 Enquiries (ENQ)

| ID | Requirement |
|---|---|
| FR-ENQ-01 | A company, a public visitor (as a lead) or an admin on behalf of a company can create an enquiry with: service category, required skills, headcount per skill, site, start date, duration or end date, shift timings, description, attachments and budget (optional). |
| FR-ENQ-02 | Enquiry states: `NEW → IN_REVIEW → QUOTED → ACCEPTED / REJECTED / EXPIRED / CANCELLED`. |
| FR-ENQ-03 | Operations Admins can assign an enquiry to themselves or another admin, and add internal notes. |
| FR-ENQ-04 | An enquiry raised by a public lead must be converted into a company account before it can be quoted. |

### 5.3 Quotations (QUO)

| ID | Requirement |
|---|---|
| FR-QUO-01 | Admins create quotations from enquiries. Line items have a description, skill, quantity (headcount), unit (per hour, day, month or fixed), rate, duration, tax rate and amount. Quotations also carry discounts, terms, validity date and payment terms (advance percentage, milestones). |
| FR-QUO-02 | Quotations are versioned. Revising a quotation creates version n+1 and supersedes the previous version. |
| FR-QUO-03 | Quotation states: `DRAFT → SENT → ACCEPTED / REJECTED / EXPIRED / SUPERSEDED`. |
| FR-QUO-04 | The company accepts or rejects in the portal. Acceptance records the user, timestamp and IP, and creates a job (FR-JOB-01). |
| FR-QUO-05 | A PDF of the quotation is generated and stored, and sent by email and WhatsApp. |
| FR-QUO-06 | Tax is calculated from configured GST rates. CGST and SGST apply when the supply is intra-state, and IGST when it is inter-state. |

---

## 6. Functional Requirements: Jobs, Matching, Invitations and Allocation

### 6.1 Allocation Lifecycle Overview
The platform must implement the following distinct, auditable stages. **No stage may be skipped, and an invitation response never directly creates an assignment.**

| # | Stage | Actor | Output |
|---|---|---|---|
| 1 | Job created | Admin or system (from quotation) | Job with positions, in `OPEN` |
| 2 | Matching executed | Admin triggers; system computes | Ranked candidate list (match run) |
| 3 | Invitations sent | Admin selects candidates | Invitations, `SENT` |
| 4 | Providers respond | Professional or Vendor Admin | Invitation response |
| 5 | Availability recorded | System | Availability snapshot on the response |
| 6 | Admin reviews candidates | Ops Admin | Shortlist |
| 7 | Allocation proposal created | Ops Admin | Proposal `DRAFT → PENDING_APPROVAL` |
| 8 | Capacity validated | System | Validation result; blocking errors prevent submission or approval |
| 9 | Proposal approved | Allocation Approver | Proposal `APPROVED` |
| 10 | Confirmed assignments created | System (atomic transaction) | Assignments `CONFIRMED` and commitments recorded |
| 11 | Notifications sent | System (queue) | WhatsApp, SMS and in-app messages to providers, workers and the company |

### 6.2 Jobs (JOB)

| ID | Requirement |
|---|---|
| FR-JOB-01 | A job is created from an accepted quotation, inheriting its positions, site, schedule and commercial terms, or manually by an admin for a company with `ACTIVE` status. |
| FR-JOB-02 | A job holds: job number (human-readable, unique), company, site, category, **positions** (skill, headcount required, minimum experience, required certifications, shift, rate), start and end dates, schedule pattern (dates and shift times), description, special instructions and status. |
| FR-JOB-03 | Job states: `DRAFT → OPEN → MATCHING → ALLOCATING → PARTIALLY_STAFFED → STAFFED → IN_PROGRESS → COMPLETED`, plus `ON_HOLD` and `CANCELLED`. Transitions are enforced by a state machine. |
| FR-JOB-04 | Each position tracks `required`, `proposed` (in pending proposals), and `confirmed` counts. `confirmed` must never exceed `required`. |
| FR-JOB-05 | Changes to a job's schedule or headcount after assignments exist require re-validation, and may create replacement or cancellation flows. |
| FR-JOB-06 | Cancelling a job cancels pending invitations and proposals, and cancels or ends assignments under the configured cancellation policy. |

### 6.3 Matching (MAT)

| ID | Requirement |
|---|---|
| FR-MAT-01 | Matching runs per job position and returns ranked candidates of two kinds: professionals, and vendors (with the count of each vendor's eligible workers). |
| FR-MAT-02 | **Hard filters** (exclusion): the provider is `APPROVED` and not suspended. For vendors, eligible workers are `ACTIVE` and verified. The provider has the required skill or category. Mandatory certifications and documents are valid and unexpired for the job period. The provider is within service radius of the site. The provider is available on the job dates (calendar). The provider has **no conflicting commitment** (assignment overlap). The provider is not on the company's blocked list. |
| FR-MAT-03 | **Soft scoring**: weighted sum of skill match and proficiency, distance, experience, performance rating, reliability (attendance rate and no-show rate), past work with the same company, and current workload. **Weights are configurable** by the Super Admin. |
| FR-MAT-04 | The weights and filters for each match run are stored as a snapshot (inputs, weights and results) for audit. |
| FR-MAT-05 | Admins can see the score breakdown, filter or sort the candidates, and manually add a provider who failed the soft criteria. Hard-filter failures can be overridden only for configurable reasons (for example distance), with a mandatory justification. Overrides are audited. Availability conflicts can never be overridden. |
| FR-MAT-06 | Matching for vendors counts eligible workers so that admins can see the maximum capacity a vendor could offer. |

### 6.4 Invitations (INV)

| ID | Requirement |
|---|---|
| FR-INV-01 | Admins send invitations to selected candidates from a match run, in bulk or individually. One invitation per provider per position is active at a time. |
| FR-INV-02 | An invitation includes: job summary (without the company's commercial rates), site area (exact address withheld until assignment), dates, shift, skill and rate offered to the provider (if configured), and response deadline (configurable, default 24 hours). |
| FR-INV-03 | Invitations are delivered by WhatsApp (with a deep link), SMS fallback and in-app message. |
| FR-INV-04 | Invitation states: `SENT → VIEWED → RESPONDED_INTERESTED / RESPONDED_DECLINED / EXPIRED / WITHDRAWN`. |
| FR-INV-05 | **Professional response**: interested or declined. If interested, the professional confirms availability for the job dates. They may mark partial availability for specific dates if the position allows it. A decline reason is optional. |
| FR-INV-06 | **Vendor response**: interested or declined. If interested, the vendor gives `offeredHeadcount` (at most its count of eligible workers) and, optionally, the specific workers it proposes. The system validates that the proposed workers are eligible and not committed. |
| FR-INV-07 | Responses are **idempotent**. Repeated submissions with the same idempotency key return the original result. Changing a response is allowed until the deadline or until the provider is included in an approved proposal, whichever comes first. Each change is versioned. |
| FR-INV-08 | **An invitation response never creates an assignment.** It only marks the candidate as interested and available for admin review. |
| FR-INV-09 | Admins can withdraw invitations. Expiry is processed by a scheduled job. |
| FR-INV-10 | When a provider responds, the response records an availability snapshot taken at that moment. This is stage 5. |

### 6.5 Allocation Proposals (ALC)

| ID | Requirement |
|---|---|
| FR-ALC-01 | Ops Admins create allocation proposals for a job. A proposal contains lines that each map a position to either a professional (from an interested response) or a specific vendor worker (from an interested vendor response). |
| FR-ALC-02 | A proposal may cover some or all positions, and several proposals may exist per job. The sum of headcount across confirmed and pending-approval proposals must not exceed the requirement. |
| FR-ALC-03 | Proposal states: `DRAFT → PENDING_APPROVAL → APPROVED / REJECTED`, plus `CANCELLED`. A rejected proposal can be cloned into a new draft. |
| FR-ALC-04 | The system validates at **submission and again at approval**: (a) each person is still eligible (status, documents and skills); (b) there is no overlapping commitment, either confirmed or held in another pending proposal; (c) the vendor has not exceeded its offered headcount; (d) the position's confirmed and proposed count stays at or below required; (e) the same person does not appear twice in the job; (f) the source invitation response is `INTERESTED` and not expired or withdrawn. |
| FR-ALC-05 | Validation results are returned for each line as blocking errors or warnings. Warnings, for example low rating, can be acknowledged; blocking errors cannot. |
| FR-ALC-06 | **Approval is atomic**: inside one MongoDB transaction, the proposal status changes from `PENDING_APPROVAL` to `APPROVED` through a conditional update, all lines are revalidated, assignments are created, commitments are inserted (enforced by a unique constraint per person per time slot, or by a conditional check), and position counters are incremented with a guard against exceeding the requirement. If any step fails, the whole approval rolls back and returns the reason. |
| FR-ALC-07 | Two approvers acting at the same time must not be able to over-allocate a position or double-book a person. Concurrency is resolved by optimistic versioning and conditional updates, and the loser receives a `409 CONFLICT`. |
| FR-ALC-08 | Notifications are queued **after the transaction commits** (outbox pattern), never inside it. |
| FR-ALC-09 | When a proposal is rejected, the reason is recorded, and the affected candidates remain available for other proposals. |

### 6.6 Assignments (ASG)

| ID | Requirement |
|---|---|
| FR-ASG-01 | An assignment links job, position, company, site, provider type, professional or (vendor and vendor worker), schedule (dates and shift times), agreed provider rate, source proposal and status. |
| FR-ASG-02 | Assignment states: `CONFIRMED → ACTIVE (on the first check-in) → COMPLETED`, plus `CANCELLED`, `REPLACED` and `NO_SHOW`. |
| FR-ASG-03 | Once an assignment is confirmed, the provider sees the full site address and site contact, and the company sees the assigned person's name, photo, skill and verification badge. Mobile numbers are revealed according to configuration. |
| FR-ASG-04 | **Replacement**: an admin can replace an assigned person. The replacement goes through the same proposal and approval flow, as a single-line "replacement proposal". On approval the old assignment becomes `REPLACED` and its commitment is released, in one transaction. |
| FR-ASG-05 | When a provider cancels after confirmation, an admin must act on it. The provider cannot cancel directly. They raise a cancellation request, which an admin approves, and the request affects their reliability score. |
| FR-ASG-06 | Commitments are released when an assignment is cancelled, replaced or completed early. |

### 6.7 Attendance (ATT)

| ID | Requirement |
|---|---|
| FR-ATT-01 | Assigned persons check in and check out from a mobile browser. Each event captures a timestamp (server time), GPS location and an optional selfie. |
| FR-ATT-02 | Check-in is validated against a geofence radius around the site (configurable). A check-in outside the geofence is flagged, not blocked. |
| FR-ATT-03 | A Vendor Admin may mark attendance for its workers when the workers have no login. These entries are tagged as proxy entries. |
| FR-ATT-04 | Company site users can confirm or dispute daily attendance. Disputes create complaints automatically. |
| FR-ATT-05 | Admins can correct attendance with a reason. Corrections are audited. |
| FR-ATT-06 | If no check-in exists by a configured threshold after shift start, the system raises a no-show alert to Ops and the vendor. |
| FR-ATT-07 | Attendance summaries (days, hours and overtime) feed invoicing when the job is billed on a time and materials basis. |

---

## 7. Functional Requirements: Business Payments and Finance

### 7.1 Invoices (INVC)

| ID | Requirement |
|---|---|
| FR-INVC-01 | Finance generates invoices for a job from one of these: quotation milestones (advance, interim, final), or attendance-based billing for a billing period. |
| FR-INVC-02 | Invoice numbers are sequential and gap-free per financial year, using a configurable prefix, for example `SC/2026-27/000123`. They are generated with an atomic counter. |
| FR-INVC-03 | Invoices are GST compliant and include GSTINs, HSN/SAC codes, place of supply and the tax split. A PDF is generated and stored. |
| FR-INVC-04 | Invoice states: `DRAFT → ISSUED → PARTIALLY_PAID → PAID`, plus `OVERDUE` (computed from the credit period), `CANCELLED` and `VOID`. Issued invoices cannot be edited; corrections use credit notes. |
| FR-INVC-05 | Credit notes reduce the payable amount on an invoice and are numbered separately. |

### 7.2 Business Payments (BPAY)

| ID | Requirement |
|---|---|
| FR-BPAY-01 | **Online**: a company pays one or more invoices through Razorpay. The system creates a Razorpay Order for the payable amount, the client completes Checkout, and the server verifies the signature. **The webhook (`payment.captured` / `order.paid`) is the source of truth** for marking the payment successful. |
| FR-BPAY-02 | **Offline**: the company or Finance records a payment with method (`BANK_TRANSFER`/NEFT/RTGS/IMPS, `CHEQUE`, `UPI_DIRECT`, `CASH` if enabled, `OTHER`), amount, date, reference number (UTR or cheque number), bank, and proof attachment. The state is `PENDING_VERIFICATION`. |
| FR-BPAY-03 | A Finance Admin with `payment.verify` verifies or rejects offline payments. The verifier cannot be the person who recorded the payment (maker-checker). Cheques move through `RECEIVED → DEPOSITED → CLEARED / BOUNCED`. |
| FR-BPAY-04 | Only **verified** or **captured** payments are allocated against invoices and change invoice balances. |
| FR-BPAY-05 | One payment may be allocated across several invoices, and one invoice may receive several payments. Allocations are stored explicitly. |
| FR-BPAY-06 | Payment states: `CREATED → PENDING / PENDING_VERIFICATION → SUCCESS / FAILED / REJECTED`, plus `PARTIALLY_REFUNDED` and `REFUNDED`. |
| FR-BPAY-07 | Duplicate offline references (the same UTR or cheque number and bank) are rejected or flagged. |
| FR-BPAY-08 | All monetary values are stored as integers in **paise**, with an explicit currency code. |
| FR-BPAY-09 | Every financial state change writes immutable **ledger entries** (double-entry style: receivable, cash or gateway clearing, refund payable). Updates to existing ledger entries are not allowed; corrections are reversing entries. |

### 7.3 Refunds (RFD)

| ID | Requirement |
|---|---|
| FR-RFD-01 | Finance initiates a refund against a successful payment, for the full or a partial amount, with a reason. Refunds above a configurable threshold need a second approver. |
| FR-RFD-02 | Online refunds go through the Razorpay Refunds API. Their status updates from the `refund.processed` and `refund.failed` webhooks. |
| FR-RFD-03 | Offline refunds are recorded with a reference and proof, and verified the same way as offline payments. |
| FR-RFD-04 | The total refunded for a payment can never exceed the captured amount. This is enforced atomically. |
| FR-RFD-05 | Refunds apply to both registration payments and business payments, each in its own domain. |

### 7.4 Webhooks and Idempotency (WHK)

| ID | Requirement |
|---|---|
| FR-WHK-01 | Razorpay webhooks are verified by HMAC signature using the raw request body. |
| FR-WHK-02 | Every webhook event is stored once, keyed by the event ID, with a unique index. Duplicate deliveries are acknowledged with `200` and not processed again. |
| FR-WHK-03 | Webhook processing is asynchronous. The endpoint stores the event and returns `200` quickly, and a BullMQ worker processes it with retries. |
| FR-WHK-04 | Status transitions are conditional and monotonic. An out-of-order event, such as `failed` arriving after `captured`, cannot downgrade a final state. |
| FR-WHK-05 | The system routes each event to the registration or business payment domain using the order's `notes.domain`, and the local order record. |

### 7.5 Reconciliation (REC)

| ID | Requirement |
|---|---|
| FR-REC-01 | **Gateway reconciliation**: a daily scheduled job fetches Razorpay payments and settlements for the previous day and matches them against local records by payment ID. Mismatches are reported: missing locally, missing at the gateway, amount mismatch or status mismatch. |
| FR-REC-02 | **Bank reconciliation**: Finance uploads a bank statement as CSV or XLSX, in a configurable column mapping. The system auto-matches statement lines to verified offline payments and Razorpay settlements, by reference, amount and date tolerance. Unmatched lines are matched manually. |
| FR-REC-03 | Each reconciliation run records its period, source, counts (matched, unmatched, exceptions), the user and its status. Exceptions are resolved with notes. |
| FR-REC-04 | **Invoice reconciliation**: receivables ageing, unapplied payments and over or under payments. |
| FR-REC-05 | Registration payments and business payments are reconciled as separate ledgers, with a combined gateway view for settlement matching. |

---

## 8. Functional Requirements: Notifications, Complaints, Reports and Audit

### 8.1 Notifications (NTF)

| ID | Requirement |
|---|---|
| FR-NTF-01 | Notification channels: WhatsApp, SMS, email and in-app (bell icon with unread count). |
| FR-NTF-02 | Notifications are driven by events, for example `invitation.sent`, `assignment.confirmed`, `payment.verified` and `registration.approved`. Each event maps to templates per channel and a channel priority order with fallback. |
| FR-NTF-03 | Templates are stored in the database with variables. WhatsApp templates reference the approved template name and language. |
| FR-NTF-04 | Notifications are sent through BullMQ queues with retry and exponential backoff, plus a dead-letter queue. The delivery status reported by provider webhooks is recorded. |
| FR-NTF-05 | Users can manage their preferences for non-critical notifications. Transactional and critical notifications (OTP, assignment, payment) cannot be disabled. |
| FR-NTF-06 | Quiet hours apply to non-urgent notifications and are configurable. |

### 8.2 Complaints (CMPL)

| ID | Requirement |
|---|---|
| FR-CMPL-01 | Companies, providers and admins can raise complaints linked to a job, assignment, payment or invoice, with a category, description, severity and attachments. |
| FR-CMPL-02 | Complaint states: `OPEN → IN_PROGRESS → RESOLVED → CLOSED`, plus `REOPENED`. Each complaint has an SLA timer per severity (configurable) and escalates when the SLA is breached. |
| FR-CMPL-03 | Complaints carry a comment thread, with internal-only notes for admins. |
| FR-CMPL-04 | A complaint against a provider that is resolved as valid affects that provider's performance score. |

### 8.3 Ratings and Performance (PERF)

| ID | Requirement |
|---|---|
| FR-PERF-01 | When an assignment is completed, the company rates the person from 1 to 5 stars with optional comments. The rating rolls up to the professional or to the vendor and worker. |
| FR-PERF-02 | The performance score is calculated from rating, attendance reliability, no-shows, valid complaints and cancellations, with configurable weights. A scheduled job recalculates it. |

### 8.4 Reports (RPT)

| ID | Report |
|---|---|
| FR-RPT-01 | Registration funnel: sign-ups, completed profiles, paid, verified and approved, by provider type. |
| FR-RPT-02 | Registration revenue by plan and period. |
| FR-RPT-03 | Job fulfilment: positions required vs. confirmed, time to staff, invitation response rate. |
| FR-RPT-04 | Provider utilisation and performance. |
| FR-RPT-05 | Attendance summary by job, site and company. |
| FR-RPT-06 | Receivables ageing, collections, refunds, and online vs. offline split. |
| FR-RPT-07 | Reconciliation exceptions. |
| FR-RPT-08 | Complaints by category, SLA compliance. |

All reports can be filtered by date, company, category and location, and exported to CSV or XLSX. Large exports run asynchronously and deliver a download link.

### 8.5 Audit Logs (AUD)

| ID | Requirement |
|---|---|
| FR-AUD-01 | Every state-changing action records: actor (user ID and role), action, entity type and ID, before and after differences (with sensitive fields redacted), IP address, user agent, request ID and timestamp. |
| FR-AUD-02 | Audit logs are append-only. The API has no update or delete operations for them, and they are retained for at least 7 years for financial entities. |
| FR-AUD-03 | Admins can search the audit log by entity, actor, action and date. |

### 8.6 System Configuration (CFG)

| ID | Requirement |
|---|---|
| FR-CFG-01 | All business configuration lives in a configuration store, editable by the Super Admin and audited. This covers OTP limits, invitation expiry, matching weights, geofence radius, SLA times, refund policies, tax rates, invoice prefix, notification fallbacks and cancellation windows. |
| FR-CFG-02 | Configuration values are cached in Redis and invalidated when they change. |

---

## 9. Business Rules

| ID | Rule |
|---|---|
| BR-REG-01 | Each provider entity pays its registration fee once. There is no renewal in the MVP. |
| BR-REG-02 | A vendor's registration covers all of its workers, up to the plan's worker cap. |
| BR-REG-03 | Unapproved providers cannot be matched, invited or assigned. |
| BR-PRV-01 | A natural person (identified by hashed ID and mobile number) may have only one active provider identity: either a professional or one vendor's worker. |
| BR-ALC-01 | Only admins create allocations. Providers cannot self-assign. |
| BR-ALC-02 | An invitation response, including "interested", never creates an assignment. |
| BR-ALC-03 | Assignments are created only by approving an allocation proposal. |
| BR-ALC-04 | A person cannot hold overlapping commitments. Overlap is checked at the date and shift level. |
| BR-ALC-05 | A position's confirmed count cannot exceed its required count. |
| BR-ALC-06 | A vendor cannot be allocated more workers than the headcount it offered in its response. |
| BR-ALC-07 | The proposal creator may not approve their own proposal when `allocation.requireSeparateApprover` is set (default `true`). |
| BR-FIN-01 | Registration and business payments are separate in collections, ledgers, reports and invoice numbering. |
| BR-FIN-02 | An offline payment affects balances only after it is verified. |
| BR-FIN-03 | Maker-checker applies to offline payment verification and to refunds above the threshold. |
| BR-FIN-04 | Financial records are never hard-deleted. |
| BR-FIN-05 | Amounts are stored in paise as integers. Rounding uses half-up rounding at line level. |

---

## 10. Non-Functional Requirements

### 10.1 Performance
| ID | Requirement |
|---|---|
| NFR-PERF-01 | p95 API latency under 300 ms for reads and under 600 ms for writes, at 100 concurrent users. |
| NFR-PERF-02 | A match run over 50,000 providers completes in under 3 seconds (using indexed geo and skill filters). |
| NFR-PERF-03 | Lists are paginated, with a default of 20 items and a maximum of 100. Cursor pagination is used for large collections. |
| NFR-PERF-04 | Approving a proposal with 50 lines completes in under 2 seconds. |

### 10.2 Scalability and Availability
- The API is stateless, so it scales horizontally. Workers scale independently.
- Target uptime is 99.5% for the MVP. MongoDB runs as a replica set (at least 3 nodes in production).
- Recovery targets: RPO of 15 minutes or less (point-in-time backup) and RTO of 4 hours or less.

### 10.3 Security
- OWASP ASVS Level 2 controls.
- TLS everywhere. Data is encrypted at rest at the database and storage level, and PII fields (bank account, ID numbers) are additionally encrypted at field level.
- Passwords are hashed with Argon2id or bcrypt (cost 12 or higher).
- Rate limiting is applied per IP and per user, and is strict on authentication and OTP.
- Inputs are validated with a whitelist using DTO validation. NoSQL injection protection rejects `$`-prefixed keys.
- CORS uses an allowlist. Helmet security headers are set. CSRF protection is unnecessary because tokens are sent as Bearer headers; if cookies are used for the refresh token, they are `HttpOnly`, `Secure` and `SameSite=Strict`.
- Secrets are supplied through environment variables or a secret manager, never committed.
- File uploads follow FR-DOC-02 and FR-DOC-03.
- Admin MFA is mandatory.
- PII access is logged.

### 10.4 Privacy and Compliance
- DPDP Act 2023: consent capture at sign-up, purpose limitation, and data export or deletion requests. Deletion anonymises PII but keeps financial and audit records as the law requires.
- GST invoicing compliance.
- Aadhaar handling: masked copies only. The full number is never stored.

### 10.5 Reliability and Data Integrity
- Allocation and all financial operations use MongoDB transactions with retry on transient errors.
- Idempotency keys (the `Idempotency-Key` header) are supported on payment creation, offline payment recording, invitation responses and proposal approval. Keys are stored for 24 hours.
- Side effects use a transactional outbox, so notifications and webhooks to internal consumers go out only after the transaction commits.

### 10.6 Observability
- Structured JSON logging (pino) with a request ID and correlation ID, and PII redaction.
- Health endpoints (`/health/live` and `/health/ready`).
- Metrics: request rate, errors, latency, queue depth and failed jobs.
- Error tracking with Sentry or equivalent.

### 10.7 Usability
- Responsive layouts from 360 px wide. Provider workflows (invitation response, attendance and documents) are mobile first.
- WCAG 2.1 AA for colour contrast, keyboard navigation and form labels.
- A clean, premium, light-themed interface with large service imagery and rounded cards. It is original and must not reuse any third-party branding.

### 10.8 Maintainability
- Strict TypeScript on both backend and frontend.
- Modular monolith with clear module boundaries and no circular dependencies.
- Test coverage of at least 80% on services and domain logic, and 100% of allocation and payment state transitions covered by tests.
- An OpenAPI (Swagger) specification generated from the code.

---

## 11. External Interface Requirements

### 11.1 API Conventions
- REST and JSON, versioned under `/api/v1`.
- Success response: `{ "success": true, "data": ..., "meta": { pagination } }`.
- Error response: `{ "success": false, "error": { "code": "ALLOCATION_CAPACITY_EXCEEDED", "message": "...", "details": [...] }, "requestId": "..." }`.
- Standard status codes are used, with `409` for state or concurrency conflicts and `422` for business rule violations.

### 11.2 Razorpay
- Orders API, Checkout (web), Payment signature verification, Refunds API, Settlements API, and webhooks (`payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`).

### 11.3 WhatsApp Business API
- Template messages for invitations, assignments, payment receipts and reminders. Delivery status comes back through webhook.

### 11.4 SMS
- A DLT-compliant provider for OTP and fallback messages, behind a provider-agnostic adapter interface.

### 11.5 Object Storage
- An S3-compatible API (AWS S3, MinIO or Cloudflare R2) using private buckets and presigned PUT and GET URLs.

---

## 12. Out of Scope for MVP
- Provider payouts or settlements through the platform. Payouts are handled outside the system; the system only records the provider rate.
- Recurring subscriptions or annual renewals.
- Native mobile apps.
- Automated assignment of any kind.
- Self-serve instant booking by companies (all jobs go through enquiry and quotation, or are created by an admin).
- Third-party background verification or KYC APIs.
- Multi-currency and multi-country support.
- E-invoicing (IRN) integration with the GST portal. This is a candidate for phase 2.
- Chat between companies and providers.

---

## 13. Assumptions Requiring Confirmation

| # | Assumption | Default taken in this SRS |
|---|---|---|
| A-01 | Who pays providers? | Off-platform. The platform invoices companies and records provider rates only. |
| A-02 | Is the registration fee paid before or after verification? | Before verification. A configurable refund applies on rejection. |
| A-03 | Must a proposal be approved by a different admin than the one who created it? | Yes, configurable, default on. |
| A-04 | Do vendor workers log in? | Optional OTP login. A vendor can mark attendance on a worker's behalf. |
| A-05 | Can companies see provider identities before assignment? | No, only after assignment is confirmed. |
| A-06 | Is the provider rate shown on invitations? | Configurable per job. |
| A-07 | Is the GSTIN mandatory for vendors? | Configurable per registration plan. |
| A-08 | What is the billing basis? | Both milestone (from the quotation) and attendance-based billing are supported. |
| A-09 | Is cash accepted as an offline method? | Disabled by default, can be turned on in configuration. |
| A-10 | What is the geographic scope at launch? | India, INR only. |
| A-11 | Is one person allowed in multiple vendors? | No, a person can be active with only one vendor at a time. |
| A-12 | What granularity do commitments use? | Date plus shift window. Overlapping time ranges on the same date conflict. |
